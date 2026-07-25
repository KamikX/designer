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
    select: () => ({
      from: () => ({
        where: () => ({ get: () => ({ v: state.artifacts.length }) })
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

import { createArtifactVersion } from './artifact'

describe('createArtifactVersion', () => {
  beforeEach(() => {
    state.artifacts.length = 0
    state.files.length = 0
    state.failFileInsert = false
    state.transactionCalls = 0
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
