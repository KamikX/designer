import type { GroupMember, Message } from './types'

/**
 * 群组这一轮**到底交付了什么**。
 *
 * ## 为什么是派生,不是新表
 *
 * 内容只有一份,就在 messages 里。另存一份"交付物"记录立刻变成第二事实
 * 来源——技能/MCP 双轨并存那次的教训还在 CLAUDE.md 里躺着。所以这里只做
 * 派生:清单的骨架本来就有,建群时每个成员都填了 `deliverable`(「需求
 * 文档」「架构设计文档」),消息又带 `author`,两个一拼就是完整清单。
 *
 * ## 哪一条消息才算"交付物"
 *
 * 一个成员会发言好几次:初稿、返工、汇合。时间线上三条并排,用户得自己
 * 猜哪条算数——这正是"整体太乱"最主要的来源。规则是 **latest wins**,
 * 但要能把汇合棒排除掉(它的产出是冲突清单,不是那个成员的专业文档)。
 *
 * 判据用**文档结构本身**,不加字段、不加表:
 *
 *   交付物 = 该成员最新一条「首行是一级标题」的完整消息
 *
 * 协作协议里本来就要求专业文档以一级标题开头,而汇合棒被要求用二级标题
 * 起头——于是它天然不占交付物的位置,返工版本也自动覆盖旧版。
 */

export interface DeliverableEntry {
  memberId: string
  memberName: string
  /** 建群时定义的产出物名,如「需求文档」。清单的"应交"一栏 */
  deliverable: string
  /** 交付物的一级标题;未交付时为空串 */
  title: string
  /** 承载交付物的消息 id;未交付时为空串。面板据此跳转 */
  messageId: string
  /** delivered = 已拿到一份带一级标题的文档;pending = 发过言但没交出文档 */
  status: 'delivered' | 'pending'
}

/** 消息正文:群组消息只有文本 part */
function textOf(message: Message): string {
  return message.parts
    .map((part) => (part.type === 'text' ? part.text : ''))
    .join('')
    .trim()
}

/** 首行是不是一级标题。要求"首行",而不是"正文里出现过"——后者会把引用当成交付 */
function leadingHeading(text: string): string | null {
  const first = text.split('\n').find((line) => line.trim().length > 0)
  const matched = first ? /^#\s+(.+?)\s*$/.exec(first.trim()) : null
  return matched ? matched[1] : null
}

/**
 * 剥掉文档末尾的交接行。
 *
 * 「@测试工程师 补用例」是编排的内部信号,进了交付物就是噪音。语义与
 * group-transcript 的 extractHandoff 同源:只看末尾,一行行往回剥,
 * 遇到正文就停——中间段落里出现的 @ 是引用,不能动。
 */
export function stripHandoff(text: string): string {
  const lines = text.replace(/\s+$/, '').split('\n')
  while (lines.length > 0) {
    const last = lines[lines.length - 1].trim()
    if (last === '' || last.startsWith('@')) lines.pop()
    else break
  }
  return lines.join('\n')
}

/**
 * 本轮交付清单。
 *
 * 只列**参与过的成员**:八个人的群里只跑了三个,清单摆八条会让人以为
 * 另外五份也该有。顺序按首次发言,和时间线一致。
 */
export function groupDeliverables(
  messages: readonly Message[],
  // 只要这三个字段:渲染层手里的是 GroupRoleMeta(没有人设和模型),
  // 收窄到最小形状两边就能共用同一份派生,不必各写一遍
  members: readonly Pick<GroupMember, 'id' | 'name' | 'deliverable'>[]
): DeliverableEntry[] {
  const byId = new Map(members.map((member) => [member.id, member]))
  const order: string[] = []
  /** memberId → 最新一条带一级标题的完整消息 */
  const latest = new Map<string, { title: string; messageId: string }>()

  for (const message of messages) {
    const author = message.author
    if (!author || author === 'user' || !byId.has(author)) continue
    if (!order.includes(author)) order.push(author)
    if (message.status !== 'complete') continue
    const title = leadingHeading(textOf(message))
    if (title) latest.set(author, { title, messageId: message.id })
  }

  return order.map((memberId) => {
    const member = byId.get(memberId)!
    const hit = latest.get(memberId)
    return {
      memberId,
      memberName: member.name,
      deliverable: member.deliverable,
      title: hit?.title ?? '',
      messageId: hit?.messageId ?? '',
      status: hit ? 'delivered' : 'pending'
    }
  })
}

/** 已交 / 应交,给徽标和收口判断用 */
export function deliverableProgress(entries: readonly DeliverableEntry[]): {
  delivered: number
  total: number
} {
  return {
    delivered: entries.filter((entry) => entry.status === 'delivered').length,
    total: entries.length
  }
}
