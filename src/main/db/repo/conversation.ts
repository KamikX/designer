import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm'
import type { Conversation, SessionSettings } from '../../../shared/types'
import { getDb } from '../index'
import { conversations } from '../schema'
import type { ConversationRow } from '../schema'

/**
 * 会话仓储。两类会话共用这张表:
 *
 * - `design`:挂在项目下,每个项目一条主会话,创建项目时自动建好
 * - `chat`:独立的纯聊天,**没有项目**(projectId 为 NULL),可以开很多条
 */

function toView(row: ConversationRow): Conversation {
  return row as Conversation
}

export function getConversation(id: string): Conversation | null {
  const row = getDb().select().from(conversations).where(eq(conversations.id, id)).get()
  return row ? toView(row) : null
}

export function listConversations(projectId: string): Conversation[] {
  return getDb()
    .select()
    .from(conversations)
    .where(eq(conversations.projectId, projectId))
    .orderBy(asc(conversations.createdAt))
    .all()
    .map(toView)
}

export function createConversation(projectId: string, kind = 'design'): Conversation {
  return toView(getDb().insert(conversations).values({ projectId, kind }).returning().get())
}

/** 项目的 design 主会话,没有就补建——老数据 / 异常中断都能自愈 */
export function ensureDesignConversation(projectId: string): Conversation {
  const existing = listConversations(projectId).find((c) => c.kind === 'design')
  return existing ?? createConversation(projectId, 'design')
}

/* ------------------------------------------------------------------ */
/* 纯聊天                                                              */
/* ------------------------------------------------------------------ */

/**
 * 聊天列表,最近活跃的在前。
 *
 * 条件里的 projectId IS NULL 不是多余的:kind 是普通文本列,没有约束能阻止
 * 将来出现一条挂在项目下的 chat,那种也不该混进独立聊天列表。
 */
export function listChats(): Conversation[] {
  return getDb()
    .select()
    .from(conversations)
    .where(and(eq(conversations.kind, 'chat'), isNull(conversations.projectId)))
    .orderBy(desc(conversations.updatedAt))
    .all()
    .map(toView)
}

/** 协作群组:kind='group',成员角色存在 settings.members 里 */
export function listGroups(): Conversation[] {
  return getDb()
    .select()
    .from(conversations)
    .where(and(eq(conversations.kind, 'group'), isNull(conversations.projectId)))
    .orderBy(desc(conversations.updatedAt))
    .all()
    .map(toView)
}

export function createGroup(name: string, members: string[]): Conversation {
  return toView(
    getDb()
      .insert(conversations)
      .values({ projectId: null, kind: 'group', title: name, settings: { members } })
      .returning()
      .get()
  )
}

export function createChat(title = ''): Conversation {
  return toView(
    getDb().insert(conversations).values({ projectId: null, kind: 'chat', title }).returning().get()
  )
}

export function renameConversation(id: string, title: string): void {
  getDb().update(conversations).set({ title }).where(eq(conversations.id, id)).run()
}

export function deleteConversation(id: string): void {
  // messages 与 workspace_roots 都带级联,不用手动清
  getDb().delete(conversations).where(eq(conversations.id, id)).run()
}

/** 有新消息时提上来。聊天列表按这个排序 */
export function touchConversation(id: string): void {
  getDb()
    .update(conversations)
    .set({ updatedAt: sql`(datetime('now'))` })
    .where(eq(conversations.id, id))
    .run()
}

/**
 * 合并保存会话选择。
 *
 * 和 saveProjectSettings 一样用合并而不是覆盖:模型选择器、技能勾选、联网
 * 开关是三个独立组件,各自变化时各存各的,整体覆盖会让后写的把前一个刚存的
 * 抹掉。也一样不动 updatedAt——聊天列表按它排序,"换了个模型"不该让这条
 * 会话跳到最前面。
 */
export function saveConversationSettings(id: string, patch: SessionSettings): void {
  const current = getConversation(id)
  if (!current) return
  getDb()
    .update(conversations)
    .set({ settings: { ...current.settings, ...patch } })
    .where(eq(conversations.id, id))
    .run()
}

/**
 * 用首条用户消息给聊天起标题。
 *
 * 只在标题还空着时写,不覆盖用户自己改过的名字。截断放在这里而不是显示层:
 * 把几千字的开场白整段存进 title 列没有意义。
 */
export function autoTitle(id: string, firstMessage: string): void {
  const current = getConversation(id)
  if (!current || current.title) return
  const title = firstMessage.replace(/\s+/g, ' ').trim().slice(0, 40)
  if (title) renameConversation(id, title)
}
