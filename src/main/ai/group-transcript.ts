import type { Message } from '../../shared/types'
import { mentionsToModelText, type GroupMentionMember } from '../../shared/group-mentions'

/**
 * 群聊记录 → 单条 transcript 文本,带上下文预算。
 *
 * 不映射成多条 user 消息:群里的发言本来就不满足"一问一答"的角色交替,
 * 有些供应商的 API 会直接拒绝连续同角色消息。拼成一份带【发言人】前缀的
 * 记录最稳,也最接近"读群聊"的心智。
 *
 * ## 为什么要折叠
 *
 * 实测一条 13 棒的接力链正文累计 22 万字,最后一棒输入近 9 万 token,
 * 远超成员模型登记的 64k 窗口——中转站不报错,只会静默截断最前面的内容,
 * 恰恰是用户原始诉求。与其被动截尾,不如主动按预算折叠。
 *
 * ## 折叠的三条铁律(永不折叠)
 *
 * 1. 用户消息——任务源头,而且通常极短;
 * 2. 每位成员**最新**的一条发言——成员的修订往往是增量补丁而非全文替换,
 *    但最新一条一定是它当前口径的落点;
 * 3. 紧邻的上一棒——交接指令所在,折了下一棒就不知道自己该干嘛。
 *
 * 折叠优先保结构(标题骨架 + 结尾交接行),配合收棒后异步生成的
 * 「前情纪要」(见 group-digest.ts)把要点补回来;纪要缺席时机械存根
 * 独立成立,不构成硬依赖。
 */

/** 粗略的 token→字符换算,与 skills/catalog.ts 同一取值:中英混排取 3 */
const CHARS_PER_TOKEN = 3
/**
 * transcript 占上下文窗口的比例。system(人设+协作协议+技能目录)、
 * 本棒的工具结果和输出都要留地方,一半给历史记录已经不小气了。
 */
const TRANSCRIPT_RATIO = 0.5
/** models 表 contextWindow 的默认值,窗口未知时按它算 */
const FALLBACK_WINDOW = 64_000
/**
 * 预算下限(字符)。窗口登记得再小,低于这个值的折叠会把刚发生的
 * 对话也折没,链条直接失忆——宁可赌供应商实际窗口没那么小。
 */
const MIN_BUDGET = 24_000
/** 折叠存根里最多保留的标题行数 */
const STUB_MAX_HEADINGS = 12
/** 各消息块之间的分隔符长度(\n\n---\n\n) */
const SEPARATOR_LENGTH = 9

export interface GroupDigestSnapshot {
  text: string
  /** 纪要已覆盖到这条消息(含)。增量更新只喂这之后的发言 */
  coveredUntilId: string
}

export interface TranscriptEntry {
  id: string
  /** 展示名(【发言人】前缀用) */
  name: string
  /** author 原始值,同名撞车时仍能按人区分"最新一条" */
  authorKey: string
  isUser: boolean
  /** 已把结构化提及转成 @名字 的正文 */
  text: string
}

export interface GroupTranscriptInput {
  messages: Message[]
  /** 当前棒的占位消息,不进记录 */
  excludeId: string
  selfName: string
  members: readonly GroupMentionMember[]
  contextWindow?: number | null
  /**
   * 懒加载前情纪要:只有真的发生折叠才读。多数会话根本不超预算,
   * 没必要每棒都去查库。
   */
  loadDigest?: () => GroupDigestSnapshot | null
}

/** 消息 → 可参与预算计算的条目(排除流式中的半条与空正文) */
export function transcriptEntries(
  messages: Message[],
  members: readonly GroupMentionMember[],
  excludeId?: string
): TranscriptEntry[] {
  const membersById = new Map(members.map((member) => [member.id, member]))
  const nameOf = (author: string | null | undefined): string =>
    author === 'user' || !author ? '用户' : (membersById.get(author)?.name ?? author)

  return messages
    .filter((m) => m.id !== excludeId && m.status !== 'streaming')
    .map((m) => {
      const raw = m.parts
        .map((p) => (p.type === 'text' ? p.text : ''))
        .join('')
        .trim()
      return {
        id: m.id,
        name: nameOf(m.author),
        authorKey: m.author ?? 'user',
        isUser: m.author === 'user' || !m.author,
        text: raw ? mentionsToModelText(raw, members) : ''
      }
    })
    .filter((entry) => entry.text)
}

function charBudget(contextWindow?: number | null): number {
  const window = contextWindow || FALLBACK_WINDOW
  return Math.max(MIN_BUDGET, window * TRANSCRIPT_RATIO * CHARS_PER_TOKEN)
}

/**
 * 折叠存根:标题骨架 + 结尾交接行。
 *
 * 保标题而不是保开头 N 字:群成员的产出是结构化文档,标题即目录,
 * 后面的成员靠它知道"这份文档讲过什么";开头 N 字只能看到第一章。
 */
function stubText(entry: TranscriptEntry): string {
  const lines = entry.text.split('\n')
  const headings = lines.filter((line) => /^#{1,3}\s/.test(line)).slice(0, STUB_MAX_HEADINGS)
  const lastLine =
    [...lines]
      .reverse()
      .find((line) => line.trim())
      ?.trim() ?? ''
  const skeleton = headings.length > 0 ? headings.join('\n') : `${entry.text.slice(0, 200)}…`
  const handoff = lastLine && !headings.includes(lastLine) ? `\n(结尾交接:${lastLine})` : ''
  return `(这条较早的发言已折叠,全文 ${entry.text.length} 字,此处只保留结构)\n${skeleton}${handoff}`
}

/**
 * 算出要折叠哪些条目(按时间序返回)。
 *
 * 一档只折"旧且已有更新发言"的条目;仍超预算才动各成员的最新一条
 * (二档)。用户消息与上一棒在任何档位都不折——见文件头的三条铁律,
 * 其中上一棒同时也是交接指令的出处。
 */
export function transcriptFoldIds(
  entries: TranscriptEntry[],
  contextWindow?: number | null
): string[] {
  const budget = charBudget(contextWindow)
  let total = entries.reduce((n, e) => n + e.text.length + SEPARATOR_LENGTH, 0)
  if (total <= budget) return []

  const lastId = entries[entries.length - 1]?.id
  const latestByAuthor = new Map<string, string>()
  for (const entry of entries) {
    if (!entry.isUser) latestByAuthor.set(entry.authorKey, entry.id)
  }

  const folded = new Set<string>()
  const fold = (entry: TranscriptEntry): void => {
    const saved = entry.text.length - stubText(entry).length
    if (saved <= 0) return
    folded.add(entry.id)
    total -= saved
  }

  for (const entry of entries) {
    if (total <= budget) break
    if (entry.isUser || entry.id === lastId) continue
    if (latestByAuthor.get(entry.authorKey) === entry.id) continue
    fold(entry)
  }
  for (const entry of entries) {
    if (total <= budget) break
    if (entry.isUser || entry.id === lastId || folded.has(entry.id)) continue
    fold(entry)
  }

  return entries.filter((entry) => folded.has(entry.id)).map((entry) => entry.id)
}

/** 上一棒结尾的交接指令:与 nextMention 同款"只看末五行"的语义 */
function extractHandoff(
  entry: TranscriptEntry,
  selfName: string
): { name: string; line: string } | null {
  const lines = entry.text.trimEnd().split('\n')
  const line = lines
    .slice(-5)
    .reverse()
    .find((candidate) => candidate.includes(`@${selfName}`))
  return line ? { name: entry.name, line: line.trim() } : null
}

export function buildGroupTranscript(input: GroupTranscriptInput): string {
  const entries = transcriptEntries(input.messages, input.members, input.excludeId)
  const folded = new Set(transcriptFoldIds(entries, input.contextWindow))
  const digest = folded.size > 0 ? (input.loadDigest?.() ?? null) : null
  const coveredIndex = digest
    ? entries.findIndex((entry) => entry.id === digest.coveredUntilId)
    : -1

  const blocks: string[] = []
  let digestEmitted = false
  entries.forEach((entry, index) => {
    // 纪要覆盖范围内的折叠条目整体让位给一份纪要块:同样的内容
    // 存根一份、纪要再一份,反而把篇幅还回去了
    if (folded.has(entry.id) && index <= coveredIndex) {
      if (!digestEmitted) {
        digestEmitted = true
        blocks.push(`【前情纪要】\n(更早的发言已折叠,以下是它们的纪要)\n\n${digest!.text.trim()}`)
      }
      return
    }
    const body = folded.has(entry.id) ? stubText(entry) : entry.text
    blocks.push(`【${entry.name}】\n${body}`)
  })

  // 交接指令埋在上一篇几万字文档的最后一行,重述一遍钉在 recency 位置,
  // 接棒的人不用从头翻
  const last = entries[entries.length - 1]
  const handoff = last ? extractHandoff(last, input.selfName) : null
  const footer = [
    handoff ? `上一棒【${handoff.name}】结尾的交接指令,这就是你本棒的任务:\n> ${handoff.line}` : '',
    `现在轮到你(${input.selfName})发言。按你的职责与协作协议产出文档。`
  ]
    .filter(Boolean)
    .join('\n\n')

  return `以下是群聊记录(按时间顺序):\n\n${blocks.join('\n\n---\n\n')}\n\n---\n\n${footer}`
}
