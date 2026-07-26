import { generateText } from 'ai'
import type { AdapterType } from '../../shared/types'
import type { GroupMentionMember } from '../../shared/group-mentions'
import { listMessages } from '../db/repo/message'
import { getGroupDigest, saveGroupDigest } from '../db/repo/group-digest'
import { getProviderRowById } from '../db/repo/provider'
import { getLanguageModel } from './registry'
import { resolveAssistantModel } from './assistant'
import { RunTraceCollector } from './run-trace'
import { openaiCompatOptions } from './provider-options'
import { transcriptEntries, transcriptFoldIds, type TranscriptEntry } from './group-transcript'

/**
 * 群组「前情纪要」的滚动更新。
 *
 * 时机是**收棒之后异步**跑,而不是在接力棒里同步生成:纪要只是折叠时的
 * 增强(机械存根独立成立),把它放进链路只会多一个失败点、拖慢每一棒的
 * 启动。生成失败静默降级——下一棒照常用结构存根。
 *
 * 增量式:旧纪要 + 新覆盖的发言 → 新纪要。输入被钳制在固定上限内,
 * 不会随会话变长而失控;覆盖水位(coveredUntilId)与 transcript 的
 * 折叠边界共用同一套纯函数,两边永远对得上。
 */

/** 单条发言喂给纪要的头/尾保留量:结论与交接通常都在这两处 */
const PER_MESSAGE_HEAD = 2500
const PER_MESSAGE_TAIL = 1500
/** 一次纪要更新的总输入上限(字符),防首次生成时把 20 万字全灌进去 */
const INPUT_MAX = 60_000
/** 后台任务也要有超时:挂死的纪要请求不该占着 in-flight 锁 */
const DIGEST_TIMEOUT_MS = 120_000

/** 同一会话同时只跑一份纪要更新,接力快时后到的直接放弃(下棒再追) */
const inflight = new Set<string>()

export interface DigestUpdateInput {
  conversationId: string
  members: readonly GroupMentionMember[]
  /**
   * 兜底模型:刚收棒成员自己的模型(已被验证可用)。
   * 实际优先用全局辅助模型——纪要正是"挑个便宜的做压缩提炼"的场景。
   */
  providerId: string
  modelId: string
  contextWindow?: number | null
}

export async function maybeUpdateGroupDigest(input: DigestUpdateInput): Promise<void> {
  if (inflight.has(input.conversationId)) return
  inflight.add(input.conversationId)
  try {
    await updateDigest(input)
  } catch (err) {
    // 纪要是尽力而为的兜底,失败只意味着下一棒退回机械折叠
    console.warn('[group-digest] 前情纪要更新失败:', err)
  } finally {
    inflight.delete(input.conversationId)
  }
}

async function updateDigest(input: DigestUpdateInput): Promise<void> {
  const entries = transcriptEntries(listMessages(input.conversationId), input.members)
  const folded = transcriptFoldIds(entries, input.contextWindow)
  if (folded.length === 0) return

  const targetId = folded[folded.length - 1]
  const targetIndex = entries.findIndex((entry) => entry.id === targetId)
  const existing = getGroupDigest(input.conversationId)
  const coveredIndex = existing
    ? entries.findIndex((entry) => entry.id === existing.coveredUntilId)
    : -1
  // 折叠边界没有前进(比如同一棒重复触发)就不花这次模型调用
  if (targetIndex <= coveredIndex) return

  const fresh = entries.slice(coveredIndex + 1, targetIndex + 1)

  // 优先全局辅助模型(设置页配的便宜模型),没配才用收棒成员的模型
  const assistant = resolveAssistantModel()
  const providerId = assistant?.providerId ?? input.providerId
  const modelId = assistant?.modelId ?? input.modelId

  // 纪要是真实计费请求,和辅助模型同理要计量(用量页按 group_digest 过滤)
  const provider = getProviderRowById(providerId)
  const trace = new RunTraceCollector({
    scene: 'group_digest',
    conversationId: input.conversationId,
    providerId,
    providerSlug: provider?.slug ?? '',
    modelId,
    adapter: provider?.adapter as AdapterType | undefined
  })
  trace.start()
  let text: string
  try {
    const result = await generateText({
      model: getLanguageModel(providerId, modelId),
      // 便宜模型常配在中转站上,同一套 OpenAI 兼容参数
      providerOptions: { openai: openaiCompatOptions() },
      prompt: digestPrompt(existing?.text ?? null, fresh),
      onLanguageModelCallStart: ({ callId }) => trace.modelCallStart(callId),
      onLanguageModelCallEnd: (event) =>
        trace.stepEnd(event.callId, event.usage, {
          finishReason: event.finishReason,
          responseTimeMs: event.performance?.responseTimeMs ?? null
        }),
      abortSignal: AbortSignal.timeout(DIGEST_TIMEOUT_MS)
    })
    trace.finish('complete')
    text = result.text
  } catch (err) {
    trace.finish('error')
    throw err
  }
  if (!text.trim()) return
  saveGroupDigest(input.conversationId, { text: text.trim(), coveredUntilId: targetId })
}

/** 长文取头尾:中段多为过程性内容,结论在开头(摘要/假设)与结尾(交接) */
function clip(text: string): string {
  if (text.length <= PER_MESSAGE_HEAD + PER_MESSAGE_TAIL) return text
  return `${text.slice(0, PER_MESSAGE_HEAD)}\n……(中间从略)……\n${text.slice(-PER_MESSAGE_TAIL)}`
}

export function digestPrompt(previous: string | null, fresh: TranscriptEntry[]): string {
  const blocks: string[] = []
  let used = 0
  for (const entry of fresh) {
    const body = clip(entry.text)
    if (used + body.length > INPUT_MAX) {
      blocks.push('(篇幅所限,更靠后的部分发言未列出)')
      break
    }
    used += body.length
    blocks.push(`【${entry.name}】\n${body}`)
  }

  return [
    '你是群聊纪要员。把下面的群聊发言压缩成一份「前情纪要」,供后续发言的成员快速了解此前的讨论。',
    [
      '要求:',
      '- 用 markdown,总长不超过 1500 字;',
      '- 必须保留:用户的原始诉求、每位成员的关键结论与决策、已达成的一致口径、尚未解决的问题;',
      '- 舍弃过程性内容;被后续发言推翻的旧结论只留一句「已被 xx 修订」;',
      '- 直接输出纪要正文,不要任何解释或前言。'
    ].join('\n'),
    previous ? `已有纪要(在其基础上合并更新):\n\n${previous}` : '',
    `新增发言:\n\n${blocks.join('\n\n---\n\n')}`
  ]
    .filter(Boolean)
    .join('\n\n')
}
