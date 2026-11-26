import { asc, eq, inArray, sql } from 'drizzle-orm'
import type { ChatUsage, Message, MessagePart } from '../../../shared/types'
import { getDb } from '../index'
import { artifacts, conversations, messages } from '../schema'
import { text } from '../../i18n'
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
    author: row.author,
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

export function deleteMessages(input: unknown): void {
  const value = input as { conversationId?: unknown; messageIds?: unknown } | null
  if (
    !value ||
    typeof value.conversationId !== 'string' ||
    !value.conversationId ||
    !Array.isArray(value.messageIds) ||
    value.messageIds.length === 0 ||
    !value.messageIds.every((id): id is string => typeof id === 'string' && id.length > 0)
  )
    throw new Error(text('chatMessages.invalidSelection'))

  const conversationId = value.conversationId
  const ids = new Set(value.messageIds)
  const db = getDb()
  db.transaction((tx) => {
    const conversation = tx
      .select()
      .from(conversations)
      .where(eq(conversations.id, conversationId))
      .get()
    if (!conversation || !['chat', 'design'].includes(conversation.kind)) {
      throw new Error(text('chatMessages.invalidSelection'))
    }
    const history = tx
      .select()
      .from(messages)
      .where(eq(messages.conversationId, conversationId))
      .all()
    if (history.some((message) => message.status === 'streaming')) {
      throw new Error(text('chatMessages.busy'))
    }
    const selected = history.filter((message) => ids.has(message.id))
    if (selected.length !== ids.size) throw new Error(text('chatMessages.invalidSelection'))
    // Chunking keeps large history selections below SQLite's bound-parameter limit.
    const selectedIds = selected.map((message) => message.id)
    for (let offset = 0; offset < selectedIds.length; offset += 500) {
      const chunk = selectedIds.slice(offset, offset + 500)
      tx.update(artifacts)
        .set({ messageId: null, updatedAt: sql`(datetime('now'))` })
        .where(inArray(artifacts.messageId, chunk))
        .run()
      tx.delete(messages).where(inArray(messages.id, chunk)).run()
    }
  })
}
