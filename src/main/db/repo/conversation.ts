import { asc, eq } from 'drizzle-orm'
import type { Conversation } from '../../../shared/types'
import { getDb } from '../index'
import { conversations } from '../schema'
import type { ConversationRow } from '../schema'

/** 会话仓储。一期每个项目只有一条 design 主会话,创建项目时自动建好。 */

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
