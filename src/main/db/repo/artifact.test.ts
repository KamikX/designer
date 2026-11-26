import { SQLiteSyncDialect } from 'drizzle-orm/sqlite-core'
import type { SQL } from 'drizzle-orm'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  artifacts: [] as Record<string, unknown>[],
  files: [] as Record<string, unknown>[],
  failFileInsert: false,
  transactionCalls: 0
}))

vi.mock('../index', () => {
  const db = {
    transaction: (run: (tx: typeof db) => unknown) => {
      state.transactionCalls += 1
      const artifacts = [...state.artifacts]
      const files = [...state.files]
      try {
        return run(db)
      } catch (error) {
        state.artifacts.splice(0, state.artifacts.length, ...artifacts)
        state.files.splice(0, state.files.length, ...files)
        throw error
      }
    },
    select: (selection?: unknown) => ({
      from: () => ({
        where: (condition: SQL) => ({
          get: () =>
            selection
              ? { v: Math.max(0, ...state.artifacts.map((a) => Number(a.version))) }
              : state.artifacts.find(
                  (a) => a.id === new SQLiteSyncDialect().sqlToQuery(condition).params[0]
                ),
          orderBy: () => ({
            all: () => {
              const id = new SQLiteSyncDialect().sqlToQuery(condition).params[0]
              return state.files.filter((f) => f.artifactId === id)
            }
          })
        })
      })
    }),
    insert: (table: { [key: string]: unknown }) => ({
      values: (values: Record<string, unknown>) => {
        if ('version' in table) {
          return {
            returning: () => ({
              get: () => {
                const row = {
                  id: `artifact-${state.artifacts.length + 1}`,
                  createdAt: '2026-07-26 00:00:00',
                  ...values
                }
                state.artifacts.push(row)
                return row
              }
            })
          }
        }
        return {
          run: () => {
            state.files.push(values)
            if (state.failFileInsert) throw new Error('file insert failed')
          }
        }
      }
    })
  }
  return { getDb: () => db }
})

import { createArtifactVersion, saveArtifactEdits } from './artifact'

describe('createArtifactVersion', () => {
  beforeEach(() => {
    state.artifacts.length = 0
    state.files.length = 0
    state.failFileInsert = false
    state.transactionCalls = 0
  })

  it('branches from an old full snapshot while numbering after the newest version', () => {
    state.artifacts.push({ id: 'old', version: 1 }, { id: 'new', version: 2 })
    state.files.push(
      { artifactId: 'old', path: 'keep.css', content: 'old styles' },
      { artifactId: 'old', path: 'index.html', content: 'old page' },
      { artifactId: 'old', path: 'remove.txt', content: 'obsolete' },
      { artifactId: 'new', path: 'new-only.txt', content: 'newer file' }
    )
    const next = createArtifactVersion({
      projectId: 'project-1',
      messageId: 'message-1',
      baseArtifactId: 'old',
      writes: new Map([['index.html', 'edited page']]),
      deletes: new Set(['remove.txt']),
      summary: 'Branch'
    })
    expect(next.version).toBe(3)
    expect(next.baseArtifactId).toBe('old')
    expect(state.files.filter((f) => f.artifactId === next.id)).toEqual([
      { artifactId: next.id, path: 'keep.css', content: 'old styles' },
      { artifactId: next.id, path: 'index.html', content: 'edited page' }
    ])
  })

  it('文件写入失败时回滚 artifact 行和已写文件', () => {
    state.failFileInsert = true

    expect(() =>
      createArtifactVersion({
        projectId: 'project-1',
        messageId: 'message-1',
        baseArtifactId: null,
        writes: new Map([['index.html', '<main />']]),
        deletes: new Set(),
        summary: ''
      })
    ).toThrow('file insert failed')

    expect(state.transactionCalls).toBe(1)
    expect(state.artifacts).toEqual([])
    expect(state.files).toEqual([])
  })
})

describe('manual code versions', () => {
  beforeEach(() => {
    state.artifacts.splice(
      0,
      state.artifacts.length,
      { id: 'base', projectId: 'p', version: 1 },
      { id: 'latest', projectId: 'p', version: 2 }
    )
    state.files.splice(
      0,
      state.files.length,
      { artifactId: 'base', path: 'index.html', content: 'old' },
      { artifactId: 'base', path: 'theme.css', content: 'styles' },
      { artifactId: 'base', path: 'keep.js', content: 'keep' }
    )
    state.failFileInsert = false
    state.transactionCalls = 0
  })

  it('branches multiple edits from a historical snapshot without changing its files', () => {
    const saved = saveArtifactEdits({
      projectId: 'p',
      baseArtifactId: 'base',
      files: [
        { path: 'index.html', content: 'new' },
        { path: 'theme.css', content: 'new styles' }
      ]
    })
    expect(saved).toMatchObject({ version: 3, baseArtifactId: 'base', messageId: null })
    expect(state.files.filter((f) => f.artifactId === saved.id)).toEqual([
      { artifactId: saved.id, path: 'keep.js', content: 'keep' },
      { artifactId: saved.id, path: 'index.html', content: 'new' },
      { artifactId: saved.id, path: 'theme.css', content: 'new styles' }
    ])
    expect(
      state.files.find((f) => f.artifactId === 'base' && f.path === 'index.html')?.content
    ).toBe('old')
  })

  it('does not create a version when edits are unchanged', () => {
    expect(
      saveArtifactEdits({
        projectId: 'p',
        baseArtifactId: 'base',
        files: [{ path: 'index.html', content: 'old' }]
      }).id
    ).toBe('base')
    expect(state.transactionCalls).toBe(0)
  })

  it.each([
    null,
    { projectId: 'other', baseArtifactId: 'base', files: [] },
    { projectId: 'p', baseArtifactId: 'missing', files: [] },
    { projectId: 'p', baseArtifactId: 'base', files: [{ path: '../secret', content: '' }] },
    { projectId: 'p', baseArtifactId: 'base', files: [{ path: 'index.html', content: 1 }] },
    { projectId: 'p', baseArtifactId: 'base', files: [null] },
    {
      projectId: 'p',
      baseArtifactId: 'base',
      files: [
        { path: 'index.html', content: 'a' },
        { path: 'index.html', content: 'b' }
      ]
    }
  ])('rejects invalid edits: %j', (input) => {
    expect(() => saveArtifactEdits(input)).toThrow()
    expect(state.transactionCalls).toBe(0)
  })

  it('rolls back a failed manual save', () => {
    state.failFileInsert = true
    expect(() =>
      saveArtifactEdits({
        projectId: 'p',
        baseArtifactId: 'base',
        files: [{ path: 'index.html', content: 'new' }]
      })
    ).toThrow('file insert failed')
    expect(state.artifacts).toHaveLength(2)
    expect(state.files).toHaveLength(3)
  })
})
