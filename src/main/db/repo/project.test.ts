import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CreateProjectInput, Project } from '../../../shared/types'

const state = vi.hoisted(() => ({
  creates: [] as Record<string, unknown>[],
  updates: [] as Record<string, unknown>[],
  updateRows: [] as Project[],
  whereClauses: [] as unknown[]
}))

const eqSpy = vi.hoisted(() => vi.fn())

vi.mock('drizzle-orm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('drizzle-orm')>()
  eqSpy.mockImplementation(actual.eq)
  return { ...actual, eq: eqSpy }
})

vi.mock('../index', () => ({
  getDb: () => ({
    insert: () => ({
      values: (values: Record<string, unknown>) => ({
        returning: () => ({
          get: () => {
            state.creates.push(values)
            return {
              id: 'project-1',
              createdAt: '2026-07-26 00:00:00',
              updatedAt: '2026-07-26 00:00:00',
              ...values
            }
          }
        })
      })
    }),
    update: () => ({
      set: (values: Record<string, unknown>) => ({
        where: (condition: unknown) => {
          state.whereClauses.push(condition)
          return {
            returning: () => ({
              get: () => {
                state.updates.push(values)
                return state.updateRows.shift()
              }
            })
          }
        },
        returning: () => ({
          get: () => {
            state.updates.push(values)
            return state.updateRows.shift()
          }
        })
      })
    })
  })
}))

import {
  createProject,
  setProjectDescription,
  setProjectCodeInstructions,
  setProjectStyleBrief,
  setProjectVisualGuidance
} from './project'
import { projects } from '../schema'

function projectInput(styleBrief?: string): CreateProjectInput {
  return {
    name: '视觉项目',
    stack: 'html',
    designMode: 'design',
    styleBrief
  }
}

function project(styleBrief: string): Project {
  return {
    id: 'project-1',
    name: '视觉项目',
    stack: 'html',
    designMode: 'design',
    targets: null,
    libs: null,
    description: '',
    codeInstructions: '',
    styleBrief,
    designDocument: '',
    visualStylePriority: 'styleBrief',
    settings: null,
    createdAt: '2026-07-26 00:00:00',
    updatedAt: '2026-07-26 00:00:00'
  }
}

describe('项目视觉方向', () => {
  beforeEach(() => {
    state.creates.length = 0
    state.updates.length = 0
    state.updateRows.length = 0
    state.whereClauses.length = 0
    eqSpy.mockClear()
  })

  it('创建时去除视觉方向首尾空白', () => {
    const created = createProject(projectInput('  温暖的手作杂志感  '))

    expect(state.creates).toEqual([expect.objectContaining({ styleBrief: '温暖的手作杂志感' })])
    expect(created.styleBrief).toBe('温暖的手作杂志感')
  })

  it('覆盖视觉方向并更新项目时间', () => {
    state.updateRows.push(project('克制的科技感'))

    expect(setProjectStyleBrief('project-1', '  克制的科技感  ')).toMatchObject({
      styleBrief: '克制的科技感'
    })
    expect(state.updates).toEqual([
      expect.objectContaining({
        styleBrief: '克制的科技感',
        updatedAt: expect.anything()
      })
    ])
  })

  it('空白视觉方向会清除为默认空字符串', () => {
    state.updateRows.push(project(''))

    expect(setProjectStyleBrief('project-1', '   ')).toMatchObject({ styleBrief: '' })
    expect(state.updates.at(-1)).toEqual(expect.objectContaining({ styleBrief: '' }))
  })

  it('不存在的项目返回 null', () => {
    expect(setProjectStyleBrief('missing', '任意方向')).toBeNull()
    expect(eqSpy).toHaveBeenCalledWith(projects.id, 'missing')
    expect(state.whereClauses).toEqual([eqSpy.mock.results[0].value])
  })
})

describe('project visual guidance persistence', () => {
  it('saves the two sources and priority in one update', () => {
    const start = state.updates.length
    const guidance = {
      styleBrief: ' Blue ',
      designDocument: '# Green\n',
      visualStylePriority: 'designDocument' as const
    }
    state.updateRows.push({ ...project('Blue'), ...guidance })
    setProjectVisualGuidance('project-1', guidance)
    expect(state.updates.slice(start)).toEqual([
      expect.objectContaining({ ...guidance, styleBrief: 'Blue', updatedAt: expect.anything() })
    ])
  })
  it('rejects invalid IPC guidance without writing', () => {
    const before = state.updates.length
    expect(() =>
      setProjectVisualGuidance('project-1', {
        styleBrief: '',
        designDocument: '',
        visualStylePriority: 'skills'
      } as never)
    ).toThrow()
    expect(state.updates).toHaveLength(before)
    expect(() => createProject({ ...projectInput(), designDocument: null } as never)).toThrow()
  })
  it('does not update document or priority through the agent brief setter', () => {
    state.updateRows.push(project('New'))
    setProjectStyleBrief('project-1', 'New')
    expect(state.updates.at(-1)).not.toHaveProperty('designDocument')
    expect(state.updates.at(-1)).not.toHaveProperty('visualStylePriority')
  })
})

describe('project description persistence', () => {
  it('updates only the description and timestamp for the requested project, including clearing it', () => {
    for (const description of ['  New background\nSecond line  ', '   ']) {
      state.updateRows.length = 0
      state.updateRows.push({ ...project('Keep style'), description: description.trim() })
      expect(setProjectDescription('project-1', description)?.description).toBe(description.trim())
      expect(state.updates.at(-1)).toEqual({
        description: description.trim(),
        updatedAt: expect.anything()
      })
      expect(eqSpy).toHaveBeenLastCalledWith(projects.id, 'project-1')
    }
  })

  it('rejects invalid IPC arguments before writing and returns null for a missing project', () => {
    const before = state.updates.length
    expect(() => setProjectDescription('', 'Description')).toThrow('Invalid project ID')
    expect(() => setProjectDescription('project-1', null as never)).toThrow(
      'Invalid project description'
    )
    expect(state.updates).toHaveLength(before)
    state.updateRows.length = 0
    expect(setProjectDescription('missing', '')).toBeNull()
  })
})

describe('project target validation', () => {
  beforeEach(() => {
    state.creates.length = 0
  })

  it('persists component development in the existing target field', () => {
    expect(createProject({ ...projectInput(), targets: ['components'] }).targets).toEqual([
      'components'
    ])
    expect(state.creates).toHaveLength(1)
  })

  it.each([
    { targets: ['web', 'mobile'] },
    { targets: ['admin', 'landing'] },
    { targets: [] },
    { targets: undefined }
  ] as { targets: CreateProjectInput['targets'] }[])(
    'preserves valid page and empty selections: %j',
    ({ targets }) => {
      const created = createProject({ ...projectInput(), targets })
      expect(created.targets).toEqual(targets?.length ? targets : null)
    }
  )

  it.each([
    { targets: ['components', 'web'] },
    { targets: ['admin', 'components'] },
    { targets: ['unknown'] },
    { targets: 'components' },
    { targets: null },
    { targets: [1] },
    { targets: [{}] },
    { targets: new Array(1) }
  ])('rejects invalid IPC targets before writing: %j', ({ targets }) => {
    expect(() => createProject({ ...projectInput(), targets } as never)).toThrow()
    expect(state.creates).toHaveLength(0)
  })
})

describe('project code instructions', () => {
  beforeEach(() => {
    state.updates.length = 0
    state.updateRows.length = 0
    state.whereClauses.length = 0
    eqSpy.mockClear()
  })

  it('updates only the requested project and preserves multiline instructions', () => {
    const instructions = 'Use Zod.\nKeep translations separate.'
    state.updateRows.push({ ...project('Blue'), codeInstructions: instructions })
    expect(setProjectCodeInstructions('project-1', `  ${instructions}  `)?.codeInstructions).toBe(
      instructions
    )
    expect(state.updates[0]).toMatchObject({ codeInstructions: instructions })
    expect(eqSpy).toHaveBeenCalledWith(projects.id, 'project-1')
    expect(state.updates[0]).not.toHaveProperty('styleBrief')
  })

  it('allows clearing instructions and rejects malformed IPC input', () => {
    setProjectCodeInstructions('project-1', '   ')
    expect(state.updates[0]).toMatchObject({ codeInstructions: '' })
    expect(() => setProjectCodeInstructions('', 'rules')).toThrow('Invalid project ID')
    expect(() => setProjectCodeInstructions('project-1', null as unknown as string)).toThrow(
      'Invalid project code instructions'
    )
  })
})
