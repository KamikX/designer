import { describe, expect, it } from 'vitest'
import type { Project } from '../../shared/types'
import { buildStyleBriefTools, createStyleArtifactTransaction } from './style-brief'
import { SessionVfs } from './session-vfs'

function project(styleBrief: string): Project {
  return {
    id: 'project-style-transaction',
    name: 'transaction',
    stack: 'html',
    designMode: 'design',
    description: '',
    styleBrief,
    targets: ['web'],
    libs: null,
    settings: null,
    createdAt: '2026-07-26T00:00:00.000Z',
    updatedAt: '2026-07-26T00:00:00.000Z'
  }
}

describe('tools 视觉方向与版本提交事务', () => {
  it('版本创建失败时恢复回合初始方向，且错误收尾不会再次创建版本', async () => {
    let persisted = '旧方向'
    let styleSaved = false
    const vfs = new SessionVfs([])
    const styleTool = buildStyleBriefTools({
      projectId: 'project-style-transaction',
      initialHasFiles: false,
      vfs,
      save: (value) => {
        persisted = value
        return project(value)
      },
      onSaved: () => {
        styleSaved = true
      }
    }).set_style_brief

    await styleTool.execute!({ styleBrief: '新方向' }, {
      toolCallId: 'style',
      messages: []
    } as never)
    vfs.write('index.html', '<main />')

    let creates = 0
    let restores = 0
    const transaction = createStyleArtifactTransaction({
      restore: (value) => {
        restores += 1
        persisted = value
        return project(value)
      }
    })

    await expect(
      transaction.commit(
        {
          styleSaved,
          previousStyleBrief: '旧方向',
          hasFileOutput: vfs.hasChanges
        },
        () => {
          creates += 1
          throw new Error('artifact failed')
        }
      )
    ).rejects.toThrow('artifact failed')
    await expect(
      transaction.commit(
        {
          styleSaved,
          previousStyleBrief: '旧方向',
          hasFileOutput: vfs.hasChanges
        },
        () => {
          creates += 1
          return { id: 'unexpected' }
        }
      )
    ).resolves.toBeNull()

    expect(persisted).toBe('旧方向')
    expect(creates).toBe(1)
    expect(restores).toBe(1)
  })

  it('只更新 StyleBrief 而没有文件时不创建版本并保留更新', async () => {
    let persisted = '旧方向'
    let creates = 0
    const transaction = createStyleArtifactTransaction({
      restore: (value) => {
        persisted = value
        return project(value)
      }
    })

    persisted = '新方向'
    await expect(
      transaction.commit(
        {
          styleSaved: true,
          previousStyleBrief: '旧方向',
          hasFileOutput: false
        },
        () => {
          creates += 1
          return { id: 'artifact' }
        }
      )
    ).resolves.toBeNull()

    expect(persisted).toBe('新方向')
    expect(creates).toBe(0)
  })
})
