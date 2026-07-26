import { describe, expect, it } from 'vitest'
import type { Project } from '../../shared/types'
import { createChatFinalizeCoordinator } from './chat-finalizer'

function project(styleBrief: string): Project {
  return {
    id: 'project-finalizer',
    name: 'finalizer',
    stack: 'html',
    designMode: 'design',
    targets: ['web'],
    libs: null,
    description: '',
    styleBrief,
    settings: null,
    createdAt: '',
    updatedAt: ''
  }
}

describe('chat finalize 协调器', () => {
  it('complete 的 artifact 失败后只创建、回滚、错误收尾各一次', async () => {
    const calls = {
      create: 0,
      restore: 0,
      settle: 0,
      done: 0,
      error: 0
    }
    let persisted = '新方向'
    const settled: Array<{ status: string; artifactId: string | null }> = []
    const emittedErrors: Array<{ message: string; artifactId: string | null }> = []
    const coordinator = createChatFinalizeCoordinator<{ id: string }>({
      artifactId: (artifact) => artifact.id,
      restoreStyle: (styleBrief) => {
        calls.restore += 1
        persisted = styleBrief
        return project(styleBrief)
      },
      settle: (result) => {
        calls.settle += 1
        settled.push({ status: result.status, artifactId: result.artifactId })
      },
      emitDone: () => {
        calls.done += 1
      },
      emitError: (error, artifactId) => {
        calls.error += 1
        emittedErrors.push({ message: String(error), artifactId })
      }
    })

    const result = await coordinator.finalize({
      status: 'complete',
      usage: { inputTokens: 1, outputTokens: 2 },
      styleCommit: {
        styleSaved: true,
        previousStyleBrief: '旧方向',
        hasFileOutput: true
      },
      createArtifact: () => {
        calls.create += 1
        throw new Error('artifact failed')
      }
    })
    const repeated = await coordinator.finalize({
      status: 'error',
      usage: null,
      error: new Error('outer catch must not resettle'),
      styleCommit: {
        styleSaved: true,
        previousStyleBrief: '旧方向',
        hasFileOutput: true
      },
      createArtifact: () => {
        calls.create += 1
        return { id: 'duplicate' }
      }
    })

    expect(result).toMatchObject({ status: 'error', artifactId: null })
    expect(repeated).toBe(result)
    expect(persisted).toBe('旧方向')
    expect(calls).toEqual({ create: 1, restore: 1, settle: 1, done: 0, error: 1 })
    expect(settled).toEqual([{ status: 'error', artifactId: null }])
    expect(emittedErrors).toEqual([{ message: 'Error: artifact failed', artifactId: null }])
  })

  it('error 入口的 artifact 成功时只做一次错误收尾并携带 artifactId', async () => {
    const settled: Array<{ status: string; artifactId: string | null }> = []
    const errors: Array<{ error: unknown; artifactId: string | null }> = []
    let creates = 0
    const coordinator = createChatFinalizeCoordinator<{ id: string }>({
      artifactId: (artifact) => artifact.id,
      restoreStyle: () => project('旧方向'),
      settle: (result) => {
        settled.push({ status: result.status, artifactId: result.artifactId })
      },
      emitDone: () => {
        throw new Error('error 不应 emit done')
      },
      emitError: (error, artifactId) => errors.push({ error, artifactId })
    })
    const original = new Error('stream failed')

    await coordinator.finalize({
      status: 'error',
      usage: null,
      error: original,
      styleCommit: {
        styleSaved: true,
        previousStyleBrief: '旧方向',
        hasFileOutput: true
      },
      createArtifact: () => {
        creates += 1
        return { id: 'artifact-1' }
      }
    })

    expect(creates).toBe(1)
    expect(settled).toEqual([{ status: 'error', artifactId: 'artifact-1' }])
    expect(errors).toEqual([{ error: original, artifactId: 'artifact-1' }])
  })

  it('没有文件的纯 StyleBrief 更新不创建 artifact，并按 complete 收尾', async () => {
    const statuses: string[] = []
    const coordinator = createChatFinalizeCoordinator<{ id: string }>({
      artifactId: (artifact) => artifact.id,
      restoreStyle: () => project('旧方向'),
      settle: (result) => {
        statuses.push(result.status)
      },
      emitDone: () => {},
      emitError: () => {
        throw new Error('不应进入 error')
      }
    })

    const result = await coordinator.finalize({
      status: 'complete',
      usage: { inputTokens: 1, outputTokens: 1 },
      styleCommit: {
        styleSaved: true,
        previousStyleBrief: '旧方向',
        hasFileOutput: false
      }
    })

    expect(result).toMatchObject({ status: 'complete', artifactId: null })
    expect(statuses).toEqual(['complete'])
  })
})
