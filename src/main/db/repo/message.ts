import { asc, eq, sql } from 'drizzle-orm'
import type { ChatUsage, Message, MessagePart } from '../../../shared/types'
import { getDb } from '../index'
import { messages } from '../schema'
import type { MessageRow } from '../schema'

/** 消息仓储。parts / usage 在库里是 JSON 文本,转换收口在这一层。 */

function toView(row: MessageRow): Message {
  let parts: MessagePart[] = []
  let usage: ChatUsage | null = null
  try {
    parts = JSON.parse(row.parts)
  } catch {
    // 坏 JSON 不让整个会话打不开
  }
  if (row.usage) {
    try {
      usage = JSON.parse(row.usage)
    } catch {
      usage = null
    }
  }
  return {
    id: row.id,
    conversationId: row.conversationId,
    role: row.role as Message['role'],
    parts,
    status: row.status as Message['status'],
    usage,
    providerSlug: row.providerSlug,
    modelId: row.modelId,
    artifactId: row.artifactId,
    createdAt: row.createdAt
  }
}

export function listMessages(conversationId: string): Message[] {
  return getDb()
    .select()
    .from(messages)
    .where(eq(messages.conversationId, conversationId))
    .orderBy(asc(messages.createdAt), asc(messages.id))
    .all()
    .map(toView)
}

export function createMessage(input: {
  conversationId: string
  role: Message['role']
  parts: MessagePart[]
  status?: Message['status']
  providerSlug?: string
  modelId?: string
  /** 群组会话的发言者(角色 id / 'user') */
  author?: string
}): Message {
  return toView(
    getDb()
      .insert(messages)
      .values({
        conversationId: input.conversationId,
        role: input.role,
        parts: JSON.stringify(input.parts),
        status: input.status ?? 'complete',
        providerSlug: input.providerSlug,
        modelId: input.modelId,
        author: input.author
      })
      .returning()
      .get()
  )
}

export function updateMessage(
  id: string,
  patch: {
    parts?: MessagePart[]
    status?: Message['status']
    usage?: ChatUsage
    artifactId?: string
  }
): Message | null {
  const row = getDb()
    .update(messages)
    .set({
      ...(patch.parts ? { parts: JSON.stringify(patch.parts) } : {}),
      ...(patch.status ? { status: patch.status } : {}),
      ...(patch.usage ? { usage: JSON.stringify(patch.usage) } : {}),
      ...(patch.artifactId ? { artifactId: patch.artifactId } : {}),
      updatedAt: sql`(datetime('now'))`
    })
    .where(eq(messages.id, id))
    .returning()
    .get()
  return row ? toView(row) : null
}

/**
 * 启动时清理上次异常退出留下的 streaming 状态——应用没了流自然也没了,
 * 标成 error 让 UI 有机会提示"生成中断"。
 */
export function markStaleStreamingAsError(): void {
  getDb()
    .update(messages)
    .set({ status: 'error', updatedAt: sql`(datetime('now'))` })
    .where(eq(messages.status, 'streaming'))
    .run()
}
