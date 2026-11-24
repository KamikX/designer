import { reactive } from 'vue'
import { acceptHMRUpdate, createPinia, defineStore, setActivePinia } from 'pinia'
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
    codeInstructions: '',
    styleBrief,
    designDocument: '',
    visualStylePriority: 'styleBrief',
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

  it('keeps the list and detail descriptions aligned after saving', async () => {
    const updated = { ...project(''), description: 'New background' }
    const setDescription = vi.fn().mockResolvedValue(updated)
    vi.stubGlobal('window', { api: { project: { setDescription } } })
    const store = useProjectStore()
    store.projects = [project('')]
    store.current = project('')

    await store.setDescription('project-1', 'New background')

    expect(setDescription).toHaveBeenCalledWith('project-1', 'New background')
    expect(store.current?.description).toBe('New background')
    expect(store.projects[0].description).toBe('New background')
    setDescription.mockRejectedValueOnce(new Error('Save failed'))
    await expect(store.setDescription('project-1', 'Unsaved')).rejects.toThrow('Save failed')
    expect(store.current?.description).toBe('New background')
    expect(store.projects[0].description).toBe('New background')
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
  it('saves cloneable visual guidance and updates project snapshots', async () => {
    const guidance = reactive({
      styleBrief: '',
      designDocument: '# Brand',
      visualStylePriority: 'designDocument' as const
    })
    const updated = { ...project(''), ...guidance }
    const setVisualGuidance = vi.fn(async (_id, payload) => {
      structuredClone(payload)
      return updated
    })
    vi.stubGlobal('window', { api: { project: { setVisualGuidance } } })
    const store = useProjectStore()
    store.projects = [project('')]
    store.current = project('')
    await store.setVisualGuidance('project-1', guidance)
    expect(store.current).toEqual(updated)
    expect(store.projects[0]).toEqual(updated)
  })
  it('adds visual guidance actions to an existing store during hot reload without losing state', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const usePreviousProjectStore = defineStore('project', {
      state: () => ({ projects: [project('Blue')], loaded: true, current: project('Blue') })
    })
    const existing = usePreviousProjectStore(pinia)
    expect(existing).not.toHaveProperty('setVisualGuidance')
    const hot = { data: { pinia }, invalidate: vi.fn() }
    acceptHMRUpdate(
      usePreviousProjectStore,
      hot as unknown as NonNullable<ImportMeta['hot']>
    )({ useProjectStore })

    const store = useProjectStore(pinia)
    expect(store).toBe(existing)
    expect(store.loaded).toBe(true)
    expect(store.current?.styleBrief).toBe('Blue')
    const guidance = {
      styleBrief: 'Blue',
      designDocument: '# Green',
      visualStylePriority: 'designDocument' as const
    }
    const updated = { ...project('Blue'), ...guidance }
    const setVisualGuidance = vi.fn().mockResolvedValue(updated)
    vi.stubGlobal('window', { api: { project: { setVisualGuidance } } })
    await store.setVisualGuidance('project-1', guidance)
    expect(setVisualGuidance).toHaveBeenCalledWith('project-1', guidance)
    expect(store.current?.designDocument).toBe('# Green')
    expect(hot.invalidate).not.toHaveBeenCalled()
  })
})

it('keeps saved code instructions aligned without replacing a different open project', async () => {
  setActivePinia(createPinia())
  const updated = { ...project('Blue'), codeInstructions: 'Use Zod.\nLocalize labels.' }
  const save = vi.fn().mockResolvedValue(updated)
  vi.stubGlobal('window', { api: { project: { setCodeInstructions: save } } })
  try {
    const store = useProjectStore()
    store.projects = [project('Blue')]
    store.current = project('Blue')
    await store.setCodeInstructions('project-1', updated.codeInstructions)
    expect(store.current?.codeInstructions).toBe(updated.codeInstructions)
    expect(store.projects[0].codeInstructions).toBe(updated.codeInstructions)
    store.current = { ...project('Other'), id: 'project-2' }
    save.mockResolvedValue({ ...updated, codeInstructions: '' })
    await store.setCodeInstructions('project-1', '')
    expect(store.current.id).toBe('project-2')
    expect(store.current.codeInstructions).toBe('')
    expect(store.projects[0].codeInstructions).toBe('')
  } finally {
    vi.unstubAllGlobals()
  }
})
