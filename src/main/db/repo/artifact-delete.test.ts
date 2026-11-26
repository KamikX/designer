import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { MIGRATIONS } from '../migrations'
import * as schema from '../schema'

let sqlite: Database.Database
let db: BetterSQLite3Database<typeof schema>
vi.mock('../index', () => ({ getDb: () => db }))
vi.mock('../../i18n', () => ({ text: (key: string) => key }))
import { createArtifactVersion, deleteArtifact, getArtifactFiles, listArtifacts } from './artifact'

beforeEach(() => {
  sqlite = new Database(':memory:')
  sqlite.pragma('foreign_keys = OFF')
  for (const migration of MIGRATIONS) sqlite.exec(migration)
  sqlite.pragma('foreign_keys = ON')
  db = drizzle(sqlite, { schema })
  db.insert(schema.projects)
    .values({ id: 'p', name: 'Project', settings: { selectedArtifactId: 'v2' } })
    .run()
  db.insert(schema.projects).values({ id: 'other', name: 'Other' }).run()
  db.insert(schema.conversations)
    .values({ id: 'c', projectId: 'p', kind: 'design', title: 'Design' })
    .run()
  db.insert(schema.messages)
    .values({ id: 'm', conversationId: 'c', role: 'assistant', artifactId: 'v2' })
    .run()
  db.insert(schema.artifacts)
    .values([
      { id: 'v1', projectId: 'p', version: 1 },
      { id: 'v2', projectId: 'p', version: 2, baseArtifactId: 'v1' },
      { id: 'v3', projectId: 'p', version: 3, baseArtifactId: 'v2' }
    ])
    .run()
  for (const id of ['v1', 'v2', 'v3']) {
    db.insert(schema.artifactFiles)
      .values({ artifactId: id, path: 'index.html', content: id })
      .run()
  }
})
afterEach(() => sqlite.close())

describe('permanent version deletion', () => {
  it('removes files and references, preserves snapshots and repairs persisted selection', () => {
    const remaining = deleteArtifact({ projectId: 'p', artifactId: 'v2' })
    expect(remaining.map((version) => version.id)).toEqual(['v3', 'v1'])
    expect(remaining[0].baseArtifactId).toBeNull()
    expect(getArtifactFiles('v2')).toEqual([])
    expect(getArtifactFiles('v3')).toEqual([{ path: 'index.html', content: 'v3' }])
    expect(db.select().from(schema.messages).get()?.artifactId).toBeNull()
    expect(
      db.select().from(schema.projects).where(eq(schema.projects.id, 'p')).get()?.settings
        ?.selectedArtifactId
    ).toBe('v3')
  })

  it('preserves a selection that was not deleted', () => {
    deleteArtifact({ projectId: 'p', artifactId: 'v1' })
    expect(
      db.select().from(schema.projects).where(eq(schema.projects.id, 'p')).get()?.settings
        ?.selectedArtifactId
    ).toBe('v2')
  })

  it('rejects the last version and repeated deletion', () => {
    deleteArtifact({ projectId: 'p', artifactId: 'v3' })
    deleteArtifact({ projectId: 'p', artifactId: 'v2' })
    expect(() => deleteArtifact({ projectId: 'p', artifactId: 'v1' })).toThrow('versions.keepLast')
    expect(() => deleteArtifact({ projectId: 'p', artifactId: 'v2' })).toThrow(
      'code.invalidVersion'
    )
    expect(listArtifacts('p')).toHaveLength(1)
    expect(getArtifactFiles('v1')).toHaveLength(1)
  })

  it.each([
    null,
    {},
    { projectId: 1, artifactId: 'v2' },
    { projectId: 'other', artifactId: 'v2' },
    { projectId: 'p', artifactId: 'missing' }
  ])('rejects invalid deletion %j', (input) => {
    expect(() => deleteArtifact(input)).toThrow('code.invalidVersion')
    expect(listArtifacts('p')).toHaveLength(3)
  })

  it('rolls back selection and references when deletion fails', () => {
    sqlite.exec(
      "CREATE TRIGGER fail_delete BEFORE DELETE ON artifacts BEGIN SELECT RAISE(ABORT, 'blocked'); END"
    )
    expect(() => deleteArtifact({ projectId: 'p', artifactId: 'v2' })).toThrow('blocked')
    expect(listArtifacts('p')).toHaveLength(3)
    expect(getArtifactFiles('v2')).toHaveLength(1)
    expect(db.select().from(schema.messages).get()?.artifactId).toBe('v2')
    expect(
      db.select().from(schema.projects).where(eq(schema.projects.id, 'p')).get()?.settings
        ?.selectedArtifactId
    ).toBe('v2')
    expect(listArtifacts('p')[0].baseArtifactId).toBe('v2')
  })

  it('continues existing numbering after deleting the newest version', () => {
    deleteArtifact({ projectId: 'p', artifactId: 'v3' })
    const next = createArtifactVersion({
      projectId: 'p',
      messageId: null,
      baseArtifactId: 'v2',
      writes: new Map(),
      deletes: new Set(),
      summary: ''
    })
    expect(next.version).toBe(3)
    expect(getArtifactFiles(next.id)).toEqual(getArtifactFiles('v2'))
  })
})
