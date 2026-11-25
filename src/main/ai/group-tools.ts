import { text as appText } from '../i18n'
import { aiText } from '../i18n'
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
    if (author === 'user' || !author) return appText('common.user')
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
        aiText('ai.groupTools.listAllMessagesInThisGroupIdSpeakerCharacterCountFirstLine') +
        aiText('ai.groupTools.forFoldedMessagesFindTheirIdsHereThenUseReadGroupMessage'),
      inputSchema: z.object({}),
      execute: async () => {
        const rows = completedMessages()
        if (rows.length === 0) return aiText('ai.groupTools.theGroupHasNoMessagesYet')
        return rows
          .map((row) => {
            const title = row.text.split('\n', 1)[0].slice(0, 60)
            return aiText('ai.groupTools.characters', row.id, row.name, row.text.length, title)
          })
          .join('\n')
      }
    }),

    read_group_message: tool({
      description:
        aiText('ai.groupTools.readAGroupMessageByLineRangeFindItsIdInFolded') +
        aiText('ai.groupTools.doNotReadLongDocumentsAllAtOnceReadTheBeginningFor', MAX_READ_LINES),
      inputSchema: z.object({
        message_id: z.string(),
        start_line: z.number().int().min(1).optional(),
        end_line: z.number().int().min(1).optional()
      }),
      execute: async (input) => {
        // 只认本群组的消息:message_id 是模型给的,当不可信输入
        const hit = completedMessages().find((row) => row.id === input.message_id)
        if (!hit)
          return aiText(
            'ai.groupTools.errorThisGroupHasNoMessageWithIdCheckListGroupMessages',
            input.message_id
          )

        const lines = hit.text.split('\n')
        const from = Math.max(1, input.start_line ?? 1)
        const to = Math.min(
          lines.length,
          input.end_line ?? from + MAX_READ_LINES - 1,
          from + MAX_READ_LINES - 1
        )
        if (from > lines.length)
          return aiText(
            'ai.groupTools.errorTheMessageHasOnlyLinesStartLineIsOutOfBounds',
            lines.length,
            from
          )

        let body = lines.slice(from - 1, to).join('\n')
        if (body.length > MAX_RESULT_CHARS) {
          body = aiText(
            'ai.groupTools.resultTruncatedRequestASmallerLineRange',
            body.slice(0, MAX_RESULT_CHARS)
          )
        }
        const note =
          from > 1 || to < lines.length
            ? aiText('ai.groupTools.thisMessageByHasLinesShowing', hit.name, lines.length, from, to)
            : ''
        return body + note
      }
    })
  }
}
