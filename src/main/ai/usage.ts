import type { LanguageModelUsage } from 'ai'
import type { AdapterType, DetailedUsage, UsageReportedFields } from '../../shared/types'

/**
 * 模型用量归一化。
 *
 * ## 为什么"未上报"必须是 null 而不是 0
 *
 * 长期聚合表按 reported_calls 区分"明确为 0"和"根本没报"。一旦这里把
 * undefined 坍缩成 0,下游就再也分不出来了——没上报缓存的 provider 会把
 * 全局缓存命中率拉成假 0,这正是本设计明令禁止的。
 *
 * ## 为什么 provider 总量走白名单提取而不是自动挑字段
 *
 * usage.raw 是 provider 原样返回的对象,可能夹带任何东西。自动序列化或
 * 启发式挑字段既有隐私风险又会把垃圾数据当真。只认每个适配器明确注册的
 * 数值字段,不认识的形状保持未上报——宁缺毋滥。
 */

/** 计数字段清洗:非负整数才算上报;小数向下取整(部分网关返回小数)。 */
function sanitizeCount(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null
  return Math.floor(value)
}

type ProviderTotalExtractor = (raw: Record<string, unknown>) => number | null

/** 兼容网关会把用量再包一层 usage,两种形状都认。 */
function readOpenAiTotal(raw: Record<string, unknown>): number | null {
  const direct = sanitizeCount(raw.total_tokens)
  if (direct != null) return direct
  const nested = raw.usage
  if (nested && typeof nested === 'object') {
    return sanitizeCount((nested as Record<string, unknown>).total_tokens)
  }
  return null
}

/**
 * 各适配器 raw 用量的总量提取白名单。anthropic 原始报文没有总量字段,
 * 只有 input/output 都在时才求和——缺一半就硬算等于伪造。
 */
const PROVIDER_TOTAL_EXTRACTORS: Record<AdapterType, ProviderTotalExtractor> = {
  openai: readOpenAiTotal,
  'openai-compatible': readOpenAiTotal,
  deepseek: readOpenAiTotal,
  anthropic: (raw) => {
    const input = sanitizeCount(raw.input_tokens)
    const output = sanitizeCount(raw.output_tokens)
    if (input == null || output == null) return null
    return input + output
  },
  google: (raw) => sanitizeCount(raw.totalTokenCount)
}

/** 从 provider raw 用量中提取白名单总量;不认识的形状返回 null。 */
export function extractProviderTotalTokens(adapter: AdapterType, raw: unknown): number | null {
  if (!raw || typeof raw !== 'object') return null
  return PROVIDER_TOTAL_EXTRACTORS[adapter]?.(raw as Record<string, unknown>) ?? null
}

/** 全 null 全未上报的空用量,作为累加起点。 */
export function emptyDetailedUsage(): DetailedUsage {
  return {
    inputTokens: null,
    noCacheTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    outputTokens: null,
    textTokens: null,
    reasoningTokens: null,
    totalTokens: null,
    providerTotalTokens: null,
    reported: {
      inputTokens: false,
      noCacheTokens: false,
      cacheReadTokens: false,
      cacheWriteTokens: false,
      outputTokens: false,
      textTokens: false,
      reasoningTokens: false,
      totalTokens: false,
      providerTotalTokens: false
    }
  }
}

/**
 * 把 AI SDK 的 StepResult.usage 归一化为 DetailedUsage。
 * raw 只在本函数栈内读取白名单字段,绝不进入返回值。
 */
export function normalizeStepUsage(
  usage: LanguageModelUsage | undefined,
  opts?: { adapter?: AdapterType }
): DetailedUsage {
  if (!usage) return emptyDetailedUsage()

  const inputDetails = usage.inputTokenDetails ?? {}
  const outputDetails = usage.outputTokenDetails ?? {}
  const values = {
    inputTokens: sanitizeCount(usage.inputTokens),
    noCacheTokens: sanitizeCount(inputDetails.noCacheTokens),
    cacheReadTokens: sanitizeCount(inputDetails.cacheReadTokens),
    cacheWriteTokens: sanitizeCount(inputDetails.cacheWriteTokens),
    outputTokens: sanitizeCount(usage.outputTokens),
    textTokens: sanitizeCount(outputDetails.textTokens),
    reasoningTokens: sanitizeCount(outputDetails.reasoningTokens),
    totalTokens: sanitizeCount(usage.totalTokens),
    providerTotalTokens: opts?.adapter ? extractProviderTotalTokens(opts.adapter, usage.raw) : null
  }

  const reported = Object.fromEntries(
    Object.entries(values).map(([key, value]) => [key, value != null])
  ) as unknown as UsageReportedFields

  return { ...values, reported }
}

/**
 * 逐字段累加两份用量。单边上报按上报的那边算,双边都没报保持 null——
 * 累计层面"报过一次"就算报过,否则多 step run 里一步缺报会把整轮拖成未知。
 */
export function addDetailedUsage(a: DetailedUsage, b: DetailedUsage): DetailedUsage {
  const keys = [
    'inputTokens',
    'noCacheTokens',
    'cacheReadTokens',
    'cacheWriteTokens',
    'outputTokens',
    'textTokens',
    'reasoningTokens',
    'totalTokens',
    'providerTotalTokens'
  ] as const

  const sum = emptyDetailedUsage()
  for (const key of keys) {
    const av = a[key]
    const bv = b[key]
    sum[key] = av == null && bv == null ? null : (av ?? 0) + (bv ?? 0)
    sum.reported[key] = a.reported[key] || b.reported[key]
  }
  return sum
}
