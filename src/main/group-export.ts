import { writeFileSync } from 'fs'
import { dialog, shell } from 'electron'
import { translate } from '../shared/i18n'
import type { Conversation, GroupMember, Message, Lang } from '../shared/types'
import { groupDeliverables, stripHandoff } from '../shared/group-deliverables'
import { mentionsToModelText } from '../shared/group-mentions'
import { normalizeGroupMembers } from '../shared/group-members'
import { sanitizeName } from '../shared/export-name'
import { getConversation } from './db/repo/conversation'
import { listMessages } from './db/repo/message'

/**
 * 群组交付导出:把散在时间线上的文档收成**一份**。
 *
 * ## 为什么不是"让最后一棒写一份汇总文档"
 *
 * 那是最容易想到也最错的做法:模型看到三份文档,最省事的动作是重抄一遍
 * 拼成第四份——产出翻倍、原作者的判断被悄悄改掉、后面的人分不清哪份算数。
 * **汇总是视图,不是文档**:内容仍然只有 messages 一份,这里只做拼装。
 *
 * ## 拼装的三条规则
 *
 * 1. 只收交付物(每人最新一条带一级标题的消息),讨论、汇总、半截的都不进;
 * 2. 剥掉末尾的交接行——「@测试工程师 补用例」是编排的内部信号,不是交付内容;
 * 3. 结构化提及转成 `@名字`:导出的是给人看的文档,不该出现 ULID。
 */

/** 交付物在正文里的顺序 = 清单顺序 = 首次发言顺序,和时间线一致 */
export function renderGroupDeliverables(
  conversation: Conversation,
  messages: Message[],
  members: GroupMember[],
  lang: Lang = 'zh-CN'
): string {
  const t = (source: string, ...values: unknown[]): string => translate(lang, source, ...values)
  const entries = groupDeliverables(messages, members)
  const delivered = entries.filter((entry) => entry.status === 'delivered')
  const byId = new Map(messages.map((message) => [message.id, message]))
  const mentionMembers = members.map((member) => ({ id: member.id, name: member.name }))

  const toc = entries.map((entry, index) => {
    const who = `@${entry.memberName}`
    return entry.status === 'delivered'
      ? `${index + 1}. ${entry.title} —— ${who}`
      : t('{0}. (未交付){1} —— {2}', index + 1, entry.deliverable, who)
  })

  const bodies = delivered.map((entry) => {
    const message = byId.get(entry.messageId)
    const raw = (message?.parts ?? [])
      .map((part) => (part.type === 'text' ? part.text : ''))
      .join('')
    const text = stripHandoff(mentionsToModelText(raw, mentionMembers)).trim()
    // 各文档自己是一级标题,整份导出的标题也是一级——降一级让层级不打架
    return t('{0}\n\n> 由 @{1} 交付', text.replace(/^#\s+/, '## '), entry.memberName)
  })

  const head = [
    `# ${conversation.title || t('协作交付')}`,
    entries.length > 0
      ? t('本轮交付 {0}/{1} 项。', delivered.length, entries.length)
      : t('本轮没有交付物。'),
    toc.length > 0 ? t('## 目录\n\n{0}', toc.join('\n')) : ''
  ].filter(Boolean)

  return [...head, ...bodies].join('\n\n---\n\n').replace(/\n{3,}/g, '\n\n') + '\n'
}

/**
 * 弹保存框写出一份 markdown。用户取消返回 null。
 *
 * 和设计稿导出(artifact-export)选目录不同:群组的产出天然就是一份文档,
 * 摊成目录反而要用户自己去拼。
 */
export async function exportGroupDeliverables(conversationId: string): Promise<string | null> {
  const lang = (await import('./config')).readConfig().lang
  const t = (source: string): string => translate(lang, source)
  const conversation = getConversation(conversationId)
  if (!conversation || conversation.kind !== 'group') throw new Error('群组不存在')

  const members = normalizeGroupMembers(conversation.settings?.members)
  const messages = listMessages(conversationId)
  const content = renderGroupDeliverables(conversation, messages, members, lang)

  const result = await dialog.showSaveDialog({
    title: t('导出协作交付'),
    defaultPath: `${sanitizeName(conversation.title || t('协作交付'))}.md`,
    filters: [{ name: 'Markdown', extensions: ['md'] }]
  })
  if (result.canceled || !result.filePath) return null

  writeFileSync(result.filePath, content, 'utf-8')
  shell.showItemInFolder(result.filePath)
  return result.filePath
}
