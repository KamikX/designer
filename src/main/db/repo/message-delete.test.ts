import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { MIGRATIONS } from '../migrations'
import * as schema from '../schema'
import { buildHistory } from '../../ai/context'

let sqlite: Database.Database
let db: BetterSQLite3Database<typeof schema>
vi.mock('../index', () => ({ getDb: () => db }))
import { createMessage, deleteMessages, listMessages, updateMessage } from './message'

beforeEach(() => {
  sqlite = new Database(':memory:')
  sqlite.pragma('foreign_keys = OFF')
  for (const migration of MIGRATIONS) sqlite.exec(migration)
  sqlite.pragma('foreign_keys = ON')
  db = drizzle(sqlite, { schema })
  db.insert(schema.projects)
    .values({ id: 'p', name: 'Project', styleBrief: 'Keep this style' })
    .run()
  db.insert(schema.conversations)
    .values([
      { id: 'c', kind: 'chat' },
      { id: 'd', kind: 'design', projectId: 'p' },
      { id: 'g', kind: 'group' },
      { id: 'other', kind: 'chat' }
    ])
    .run()
})
afterEach(() => sqlite.close())

function add(
  conversationId: string,
  content: string,
  role: 'user' | 'assistant' = 'user'
): ReturnType<typeof createMessage> {
  return createMessage({ conversationId, role, parts: [{ type: 'text', text: content }] })
}

describe('message deletion', () => {
  it('permanently removes only selected messages from reloaded history and model context', () => {
    const first = add('c', 'obsolete instruction')
    const answer = add('c', 'old response', 'assistant')
    const keep = add('c', 'keep this instruction')
    deleteMessages({ conversationId: 'c', messageIds: [first.id, answer.id, first.id] })
    expect(listMessages('c').map((message) => message.id)).toEqual([keep.id])
    expect(buildHistory(listMessages('c'), 64000)).toEqual([
      { role: 'user', content: 'keep this instruction' }
    ])
    deleteMessages({ conversationId: 'c', messageIds: [keep.id] })
    expect(listMessages('c')).toEqual([])
    expect(buildHistory(listMessages('c'), 64000)).toEqual([])
  })

  it('preserves project snapshots and guidance while clearing artifact message references', () => {
    const message = add('d', 'generated design', 'assistant')
    db.insert(schema.artifacts)
      .values({ id: 'v', projectId: 'p', version: 1, messageId: message.id })
      .run()
    db.insert(schema.artifactFiles)
      .values({ artifactId: 'v', path: 'index.html', content: 'design' })
      .run()
    deleteMessages({ conversationId: 'd', messageIds: [message.id] })
    expect(db.select().from(schema.artifacts).get()?.messageId).toBeNull()
    expect(db.select().from(schema.artifactFiles).get()?.content).toBe('design')
    expect(db.select().from(schema.projects).get()?.styleBrief).toBe('Keep this style')
  })

  it('rejects foreign and missing messages without partially deleting the selection', () => {
    const own = add('c', 'own')
    const foreign = add('other', 'foreign')
    for (const invalid of [foreign.id, 'missing']) {
      expect(() => deleteMessages({ conversationId: 'c', messageIds: [own.id, invalid] })).toThrow()
      expect(listMessages('c')).toHaveLength(1)
      expect(listMessages('other')).toHaveLength(1)
    }
  })

  it.each([
    null,
    {},
    { conversationId: 'c', messageIds: [] },
    { conversationId: 'c', messageIds: [42] },
    { conversationId: 'c', messageIds: [''] },
    { conversationId: 1, messageIds: ['x'] },
    { conversationId: 'missing', messageIds: ['x'] }
  ])('rejects malformed requests %j', (input) => {
    expect(() => deleteMessages(input)).toThrow()
  })

  it('rejects group chats and any deletion during streaming', () => {
    const group = add('g', 'deliverable')
    expect(() => deleteMessages({ conversationId: 'g', messageIds: [group.id] })).toThrow()
    const old = add('c', 'old')
    const active = createMessage({
      conversationId: 'c',
      role: 'assistant',
      parts: [],
      status: 'streaming'
    })
    expect(() => deleteMessages({ conversationId: 'c', messageIds: [old.id] })).toThrow()
    expect(listMessages('c')).toHaveLength(2)
    updateMessage(active.id, { status: 'complete' })
    deleteMessages({ conversationId: 'c', messageIds: [old.id] })
    expect(listMessages('c').map((message) => message.id)).toEqual([active.id])
  })

  it('rolls back artifact reference changes if the deletion fails', () => {
    const message = add('d', 'design')
    db.insert(schema.artifacts)
      .values({ id: 'v', projectId: 'p', version: 1, messageId: message.id })
      .run()
    sqlite.exec(
      "CREATE TRIGGER reject_delete BEFORE DELETE ON messages BEGIN SELECT RAISE(ABORT, 'failure'); END"
    )
    expect(() => deleteMessages({ conversationId: 'd', messageIds: [message.id] })).toThrow(
      'failure'
    )
    expect(db.select().from(schema.artifacts).get()?.messageId).toBe(message.id)
    expect(listMessages('d')).toHaveLength(1)
  })
})
