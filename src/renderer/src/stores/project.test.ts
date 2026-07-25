import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Project } from '@shared/types'
import { useProjectStore } from './project'

function project(styleBrief: string): Project {
  return {
    id: 'project-1',
    name: '运营后台',
    stack: 'vue3',
    designMode: 'design',
    targets: ['admin'],
    libs: ['antdv-next'],
    description: '',
    styleBrief,
    settings: null,
    createdAt: '2026-07-26T00:00:00.000Z',
    updatedAt: '2026-07-26T00:00:00.000Z'
  }
}

describe('project store setStyleBrief', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('同步项目列表与当前工作台中的项目快照', async () => {
    const updated = project('深色工业感')
    const setStyleBrief = vi.fn().mockResolvedValue(updated)
    vi.stubGlobal('window', { api: { project: { setStyleBrief } } })
    const store = useProjectStore()
    store.projects = [project('')]
    store.current = project('')

    await store.setStyleBrief('project-1', '  深色工业感  ')

    expect(setStyleBrief).toHaveBeenCalledWith('project-1', '  深色工业感  ')
    expect(store.projects[0]).toEqual(updated)
    expect(store.current).toEqual(updated)
  })

  it('项目不存在时保留现有快照', async () => {
    const original = project('')
    vi.stubGlobal('window', {
      api: { project: { setStyleBrief: vi.fn().mockResolvedValue(null) } }
    })
    const store = useProjectStore()
    store.projects = [original]
    store.current = original

    await store.setStyleBrief('project-1', '新方向')

    expect(store.projects[0]?.styleBrief).toBe('')
    expect(store.current?.styleBrief).toBe('')
  })
})
