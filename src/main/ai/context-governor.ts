import type { ModelMessage, ToolSet } from 'ai'
import { compactToolHistory } from './compact-tool-history'
import type { RunContextLedger } from './run-context-ledger'
import { renderToolResult, toolError } from './tool-result'

/**
 * 上下文治理器:step 级的程序化预算。
 *
 * ## 为什么不能只靠 stopWhen 和提示词
 *
 * stopWhen 只能阻止**下一个** step,挡不住模型在单个 step 里一次吐出超过
 * 剩余额度的并行工具调用;提示词里的"最多 40 次"对失控的循环没有强制力。
 * 所以三层配合:
 * - ToolBudgetGate:所有 execute 外层共用的**同步**名额预留,先到先得,
 *   超出的调用直接返回 TOOL_BUDGET_EXCEEDED,不产生任何副作用;
 * - prepareStep:20 次 / 3× 窗口触发历史压缩与合并指引,30 次后禁止
 *   重读未变化文件;
 * - shouldStop:40 次 / 5× 窗口结束循环,已完成的修改照常保留。
 *
 * ## token 估算的口径
 *
 * provider 报了 input token 就用报的;没报时按本 step 最终序列化字符数
 * `ceil(chars / 2)` 保守估算,并标记 estimated——估算只用于熔断与诊断,
 * 永不写进长期"provider 报告"字段。
 */

/** 64K 模型的默认分级预算 */
export const SOFT_TOOL_LIMIT = 20
export const NO_REREAD_TOOL_LIMIT = 30
export const HARD_TOOL_LIMIT = 40
const COMPACT_WINDOW_MULTIPLIER = 3
const STOP_WINDOW_MULTIPLIER = 5

/**
 * 同步预留名额的工具闸门。reserve 在 execute promise 开始前同步改内存
 * 计数,并行调用不可能越过上限;同一 callId 重复 reserve 幂等。
 */
export class ToolBudgetGate {
  private reserved = new Set<string>()

  constructor(private readonly limit: number = HARD_TOOL_LIMIT) {}

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
  private estimatedInputTokens = 0
  private estimated = false

  constructor(options: GovernorOptions) {
    this.ledger = options.ledger
    this.gate = options.gate
    this.contextWindow = options.contextWindow
  }

  /** 累计输入:已上报优先;完全没报过才用估算,并如实标记 */
  cumulativeInputTokens(): { value: number; reported: boolean } {
    const reported = this.ledger.cumulativeUsage.inputTokens
    if (this.ledger.cumulativeUsage.reported.inputTokens && reported != null) {
      return { value: reported, reported: true }
    }
    return { value: this.estimatedInputTokens, reported: false }
  }

  usageEstimated(): boolean {
    return this.estimated && !this.ledger.cumulativeUsage.reported.inputTokens
  }

  /** 30 次之后拒绝重读未变化的文件;返回给模型的拒绝文案,可通过则 null */
  readGate(path: string, revision: number): string | null {
    if (this.gate.count() < NO_REREAD_TOOL_LIMIT) return null
    if (!this.ledger.hasReadAtRevision(path, revision)) return null
    return (
      `${path} 在本轮已读过且未变化(工具调用已达 ${this.gate.count()} 次)。` +
      '不要重读,基于已有内容直接修改。'
    )
  }

  /** 40 次 / 5× 窗口:停止循环,保留已完成的修改 */
  shouldStop(): boolean {
    if (this.gate.count() >= HARD_TOOL_LIMIT) return true
    return this.cumulativeInputTokens().value >= STOP_WINDOW_MULTIPLIER * this.contextWindow
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
      this.gate.count() >= SOFT_TOOL_LIMIT ||
      tokens >= COMPACT_WINDOW_MULTIPLIER * this.contextWindow

    if (!needCompact) return {}

    const compacted = compactToolHistory(input.messages, {
      completedWrites: this.ledger.completedWrites,
      recentErrors: this.ledger.recentErrors,
      activatedSkills: this.ledger.activatedSkills,
      extraNotes: [
        `预算提醒:本轮已用 ${this.gate.count()} 次工具调用(硬上限 ${HARD_TOOL_LIMIT} 次)。` +
          '请合并剩余操作:同文件用 multi_edit_file / apply_string_edits 一次改完,尽快收尾。'
      ]
    })
    return { messages: compacted }
  }
}
