import type { ModelMessage, ToolSet } from 'ai'
import { DEFAULT_TOOL_CALL_LIMIT } from '../../shared/limits'
import { compactToolHistory } from './compact-tool-history'
import type { RunContextLedger } from './run-context-ledger'
import { renderToolResult, toolError } from './tool-result'

/**
 * 上下文治理器:step 级的程序化预算。
 *
 * ## 为什么不能只靠 stopWhen 和提示词
 *
 * stopWhen 只能阻止**下一个** step,挡不住模型在单个 step 里一次吐出超过
 * 剩余额度的并行工具调用;提示词里的"最多 N 次"对失控的循环没有强制力。
 * 所以三层配合:
 * - ToolBudgetGate:所有 execute 外层共用的**同步**名额预留,先到先得,
 *   超出的调用直接返回 TOOL_BUDGET_EXCEEDED,不产生任何副作用;
 * - prepareStep:软阈值 / 3× 窗口触发历史压缩与合并指引,禁重读阈值后
 *   拒绝重读未变化文件;
 * - shouldStop:硬上限 / 5× 窗口结束循环,已完成的修改照常保留。
 *
 * ## token 估算的口径
 *
 * provider 报了 input token 就用报的;没报时按本 step 最终序列化字符数
 * `ceil(chars / 2)` 保守估算,并标记 estimated——估算只用于熔断与诊断,
 * 永不写进长期"provider 报告"字段。
 */

/** 不限次数时,压缩与禁重读仍按这两个固定值生效 */
const UNLIMITED_SOFT = 20
const UNLIMITED_NO_REREAD = 30
const COMPACT_WINDOW_MULTIPLIER = 3
const STOP_WINDOW_MULTIPLIER = 5
/** cache read 的计费权重(约全价 1 折),熔断按成本口径累计 */
const CACHE_READ_WEIGHT = 0.1

export interface ToolLimits {
  /** 硬上限。Infinity 表示不限次数 */
  hard: number
  /** 触发历史压缩与"合并剩余操作"指引 */
  soft: number
  /** 之后拒绝重读未变化的文件 */
  noReread: number
}

/**
 * 把用户配的一个数摊成三档阈值。
 *
 * 原来 20 / 30 / 40 正好是硬上限的 50% / 75% / 100%,按这个比例缩放即可:
 * 上限调到 200 时还在第 20 次就压缩历史,压得太早,后面每一步都在读被
 * 折叠掉的东西。
 *
 * @param limit 0(或负数)表示不限次数。这时**只剩 token 窗口那一条熔断**,
 *        软阈值与禁重读退回固定值——它们防的是上下文膨胀,和次数上限
 *        是两件事,不该跟着一起消失。
 */
/**
 * 项目覆盖 > 全局配置。
 *
 * `null` / `undefined` 都是"没设过",要落到全局;`0` 是**用户明确要不限**,
 * 必须能穿过来——所以这里不能用 `||`。
 */
export function effectiveToolCallLimit(
  projectLimit: number | null | undefined,
  globalLimit: number | undefined
): number {
  if (typeof projectLimit === 'number' && Number.isFinite(projectLimit) && projectLimit >= 0) {
    return projectLimit
  }
  if (typeof globalLimit === 'number' && Number.isFinite(globalLimit) && globalLimit >= 0) {
    return globalLimit
  }
  return DEFAULT_TOOL_CALL_LIMIT
}

export function resolveToolLimits(limit: number): ToolLimits {
  if (!Number.isFinite(limit) || limit <= 0) {
    return { hard: Infinity, soft: UNLIMITED_SOFT, noReread: UNLIMITED_NO_REREAD }
  }
  const hard = Math.floor(limit)
  return { hard, soft: Math.ceil(hard / 2), noReread: Math.ceil((hard * 3) / 4) }
}

/**
 * 同步预留名额的工具闸门。reserve 在 execute promise 开始前同步改内存
 * 计数,并行调用不可能越过上限;同一 callId 重复 reserve 幂等。
 */
export class ToolBudgetGate {
  private reserved = new Set<string>()

  constructor(private readonly limit: number = Infinity) {}

  reserve(callId: string): boolean {
    if (this.reserved.has(callId)) return true
    if (this.reserved.size >= this.limit) return false
    this.reserved.add(callId)
    return true
  }

  count(): number {
    return this.reserved.size
  }
}

const BUDGET_EXCEEDED_TEXT = renderToolResult(
  toolError(
    'TOOL_BUDGET_EXCEEDED',
    '本轮工具调用已达硬上限,此调用未执行。已完成的修改都已保存,请直接收尾总结。'
  )
)

/** 阈值文案里的次数。不限时不写数字,免得模型对着 Infinity 犯迷糊 */
function limitText(limit: number): string {
  return Number.isFinite(limit) ? `${limit} 次` : '不限次数'
}

/**
 * 把整套工具的 execute 包上同一个闸门。读写一视同仁:副作用与额度都在
 * reserve 这一步定生死,底层 execute 在被拒时**根本不会被调用**。
 */
export function wrapToolsWithBudget(tools: ToolSet, gate: ToolBudgetGate): ToolSet {
  const wrapped: ToolSet = {}
  for (const [name, entry] of Object.entries(tools)) {
    const execute = entry.execute
    if (!execute) {
      wrapped[name] = entry
      continue
    }
    wrapped[name] = {
      ...entry,
      execute: async (input: never, options: never) => {
        const callId = (options as { toolCallId?: string })?.toolCallId ?? `${name}-${gate.count()}`
        if (!gate.reserve(callId)) return BUDGET_EXCEEDED_TEXT
        return execute(input, options)
      }
    } as ToolSet[string]
  }
  return wrapped
}

interface GovernorOptions {
  ledger: RunContextLedger
  gate: ToolBudgetGate
  contextWindow: number
  /** 缺省按全局默认上限派生;实际调用方都从用户配置算好了传进来 */
  limits?: ToolLimits
}

export interface GovernPrepareInput {
  messages: ModelMessage[]
  /** 本 step 最终会发出的 instructions + messages + tool schema 的序列化字符数 */
  serializedChars: number
}

export interface GovernPrepareResult {
  /** 需要改写历史时返回;否则不动(维持 provider 前缀缓存) */
  messages?: ModelMessage[]
}

export class ContextGovernor {
  private readonly ledger: RunContextLedger
  private readonly gate: ToolBudgetGate
  private readonly contextWindow: number
  private readonly limits: ToolLimits
  private estimatedInputTokens = 0
  private estimated = false

  constructor(options: GovernorOptions) {
    this.ledger = options.ledger
    this.gate = options.gate
    this.contextWindow = options.contextWindow
    this.limits = options.limits ?? resolveToolLimits(DEFAULT_TOOL_CALL_LIMIT)
  }

  /**
   * 累计输入:已上报优先;完全没报过才用估算,并如实标记。
   *
   * 缓存命中按 1 折计入:这条熔断守的是**花费**,而 cache read 的计费约为
   * 全价的 10%。每步重发全量历史时,前缀缓存命中的部分若按全价累计,
   * 大窗口模型开着缓存也会在几十步后被判"超预算"——账面超了,钱包没超。
   */
  cumulativeInputTokens(): { value: number; reported: boolean } {
    const usage = this.ledger.cumulativeUsage
    if (usage.reported.inputTokens && usage.inputTokens != null) {
      const cacheRead = usage.reported.cacheReadTokens ? (usage.cacheReadTokens ?? 0) : 0
      const discounted = usage.inputTokens - cacheRead * (1 - CACHE_READ_WEIGHT)
      return { value: Math.max(0, Math.round(discounted)), reported: true }
    }
    return { value: this.estimatedInputTokens, reported: false }
  }

  usageEstimated(): boolean {
    return this.estimated && !this.ledger.cumulativeUsage.reported.inputTokens
  }

  /** 禁重读阈值之后拒绝重读未变化的文件;返回给模型的拒绝文案,可通过则 null */
  readGate(path: string, revision: number): string | null {
    if (this.gate.count() < this.limits.noReread) return null
    if (!this.ledger.hasReadAtRevision(path, revision)) return null
    return (
      `${path} 在本轮已读过且未变化(工具调用已达 ${this.gate.count()} 次)。` +
      '不要重读,基于已有内容直接修改。'
    )
  }

  /** 硬上限 / 5× 窗口:停止循环,保留已完成的修改 */
  shouldStop(): boolean {
    if (this.gate.count() >= this.limits.hard) return true
    return this.cumulativeInputTokens().value >= STOP_WINDOW_MULTIPLIER * this.contextWindow
  }

  /** 触顶的是次数还是 token,诊断里各记各的熔断 */
  hitToolLimit(toolCalls: number): boolean {
    return toolCalls >= this.limits.hard
  }

  /** 收尾文案要说出真实上限,不能再写死 40 */
  hardLimitText(): string {
    return limitText(this.limits.hard)
  }

  /**
   * 下一次模型请求前的治理决策。没触阈值时**什么都不返回**——改写历史
   * 会打破 provider 前缀缓存,不到阈值不动它;工具 schema 一轮内保持稳定。
   */
  prepareStep(input: GovernPrepareInput): GovernPrepareResult {
    // provider 没报 input 时用本 step 的序列化字符数保守估算
    if (!this.ledger.cumulativeUsage.reported.inputTokens) {
      this.estimatedInputTokens = Math.ceil(input.serializedChars / 2)
      this.estimated = true
    }

    const tokens = this.cumulativeInputTokens().value
    const needCompact =
      this.gate.count() >= this.limits.soft ||
      tokens >= COMPACT_WINDOW_MULTIPLIER * this.contextWindow

    if (!needCompact) return {}

    const compacted = compactToolHistory(input.messages, {
      completedWrites: this.ledger.completedWrites,
      recentErrors: this.ledger.recentErrors,
      activatedSkills: this.ledger.activatedSkills,
      /*
       * 提醒里**不写当前已用次数**:这段会随消息一起重发,每步一个新数字
       * 就是每步一个新前缀,缓存从这里往后全废。上限是常量,写它足够表达
       * "该收尾了",而"已用几次"模型从自己的调用历史里看得出来。
       */
      extraNotes: [
        `预算提醒:本轮工具调用接近上限(硬上限 ${limitText(this.limits.hard)})。` +
          '请合并剩余操作:同文件用 multi_edit_file / apply_string_edits 一次改完,尽快收尾。'
      ]
    })
    return { messages: compacted }
  }
}
