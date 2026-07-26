import { tool } from 'ai'
import type { ToolSet } from 'ai'
import { z } from 'zod'
import { listMessages } from '../db/repo/message'
import type { GroupMentionMember } from '../../shared/group-mentions'

/**
 * 群聊历史回读工具。
 *
 * transcript 超预算时旧发言会被折叠成结构存根(见 group-transcript.ts),
 * 纪要只保要点——当成员真的需要逐字引用一篇被折叠的旧文档(旧版字段定义、
 * 某条验收口径的原文)时,靠这两个工具按需取回,而不是把全文塞回 transcript
 * 挤爆下一棒。
 *
 * 只读且幂等:读一百遍也只是消耗工具调用预算(与其他工具共享 40 次封顶),
 * 不会滚雪球——工具结果只活在当前棒,不落库、不进后续棒的 transcript。
 */

/** 单次读取的输出上限,与 local-tools 的 MAX_RESULT_CHARS 同一取值 */
const MAX_RESULT_CHARS = 12000
/** 单次读取的行数上限:引导按段读,别一口吞四万字文档 */
const MAX_READ_LINES = 400

export function buildGroupHistoryTools(
  conversationId: string,
  members: readonly GroupMentionMember[]
): ToolSet {
  const nameOf = (author: string | null | undefined): string => {
    if (author === 'user' || !author) return '用户'
    return members.find((member) => member.id === author)?.name ?? author
  }
  /** 每次调用现查库:接力过程中会不断有新消息落库,快照会读旧 */
  const completedMessages = (): { id: string; name: string; text: string }[] =>
    listMessages(conversationId)
      .filter((message) => message.status !== 'streaming')
      .map((message) => ({
        id: message.id,
        name: nameOf(message.author),
        text: message.parts
          .map((part) => (part.type === 'text' ? part.text : ''))
          .join('')
          .trim()
      }))
      .filter((message) => message.text)

  return {
    list_group_messages: tool({
      description:
        '列出本群组的全部历史消息(id / 发言人 / 字数 / 首行标题)。' +
        '群聊记录里标注「已折叠」的旧发言,先用它找到消息 id,再用 read_group_message 读原文。',
      inputSchema: z.object({}),
      execute: async () => {
        const rows = completedMessages()
        if (rows.length === 0) return '群里还没有消息。'
        return rows
          .map((row) => {
            const title = row.text.split('\n', 1)[0].slice(0, 60)
            return `${row.id} | ${row.name} | ${row.text.length} 字 | ${title}`
          })
          .join('\n')
      }
    }),

    read_group_message: tool({
      description:
        '按行区间读取一条群消息的原文(消息 id 见群聊记录的折叠标注或 list_group_messages)。' +
        `长文档**不要一次读完**:先读开头看目录,再按 start_line / end_line 取需要的章节,单次最多 ${MAX_READ_LINES} 行。`,
      inputSchema: z.object({
        message_id: z.string(),
        start_line: z.number().int().min(1).optional(),
        end_line: z.number().int().min(1).optional()
      }),
      execute: async (input) => {
        // 只认本群组的消息:message_id 是模型给的,当不可信输入
        const hit = completedMessages().find((row) => row.id === input.message_id)
        if (!hit)
          return `错误:本群组里没有 id 为「${input.message_id}」的消息。先用 list_group_messages 查。`

        const lines = hit.text.split('\n')
        const from = Math.max(1, input.start_line ?? 1)
        const to = Math.min(
          lines.length,
          input.end_line ?? from + MAX_READ_LINES - 1,
          from + MAX_READ_LINES - 1
        )
        if (from > lines.length)
          return `错误:该消息只有 ${lines.length} 行,start_line=${from} 越界。`

        let body = lines.slice(from - 1, to).join('\n')
        if (body.length > MAX_RESULT_CHARS) {
          body = `${body.slice(0, MAX_RESULT_CHARS)}\n\n…结果过长已截断,请缩小行区间。`
        }
        const note =
          from > 1 || to < lines.length
            ? `\n\n---\n【${hit.name}】的这条消息共 ${lines.length} 行,当前看的是 ${from}-${to}。`
            : ''
        return body + note
      }
    })
  }
}
