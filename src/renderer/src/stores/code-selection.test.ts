import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useArtifactStore } from './artifact'
import { MAX_CODE_SELECTIONS, normalizeCodeRange, useCodeSelectionStore } from './code-selection'

const range = { startLine: 1, startColumn: 1, endLine: 2, endColumn: 3 }
function setup(): ReturnType<typeof useCodeSelectionStore> {
  const artifact = useArtifactStore()
  artifact.projectId = 'p'
  artifact.currentId = 'v1'
  artifact.files = [
    { path: 'App.vue', content: 'x'.repeat(80) + '\nsecond' },
    { path: 'theme.css', content: 'body {}' }
  ]
  return useCodeSelectionStore()
}
beforeEach(() => setActivePinia(createPinia()))

describe('code selections', () => {
  it('normalizes reverse selections and rejects empty or invalid coordinates', () => {
    expect(normalizeCodeRange({ startLine: 2, startColumn: 3, endLine: 1, endColumn: 1 })).toEqual(
      range
    )
    expect(normalizeCodeRange({ startLine: 1, startColumn: 5, endLine: 1, endColumn: 2 })).toEqual({
      startLine: 1,
      startColumn: 2,
      endLine: 1,
      endColumn: 5
    })
    expect(normalizeCodeRange({ ...range, endLine: 1, endColumn: 1 })).toBeNull()
    expect(normalizeCodeRange({ ...range, startLine: 0 })).toBeNull()
  })
  it('deduplicates, caps and removes ranges', () => {
    const store = setup()
    expect(store.add('App.vue', range)).toBe(true)
    expect(store.add('App.vue', range)).toBe(false)
    for (let i = 1; i < MAX_CODE_SELECTIONS; i++)
      expect(store.add('App.vue', { ...range, endLine: 1, endColumn: i + 1 })).toBe(true)
    expect(store.add('theme.css', { ...range, endLine: 1, endColumn: 3 })).toBe(false)
    store.remove(store.selections[0].id)
    expect(store.add('theme.css', { ...range, endLine: 1, endColumn: 3 })).toBe(true)
  })
  it('preserves selections across file switches and invalidates changed files synchronously', () => {
    const store = setup()
    store.add('App.vue', range)
    store.add('theme.css', { ...range, endLine: 1, endColumn: 3 })
    const artifact = useArtifactStore()
    artifact.selectedPath = 'theme.css'
    expect(store.selections).toHaveLength(2)
    artifact.editFile('App.vue', 'changed')
    expect(store.selections.map((item) => item.path)).toEqual(['theme.css'])
    artifact.discardEdits()
    expect(store.selections).toHaveLength(1)
    artifact.files = []
    expect(store.selections).toEqual([])
  })
  it.each(['projectId', 'currentId'] as const)(
    'invalidates a changed %s without an editor',
    (key) => {
      const store = setup()
      store.add('App.vue', range)
      useArtifactStore()[key] = 'other'
      expect(store.selections).toEqual([])
    }
  )
  it('rejects missing files, out of bounds ranges, drafts and loading', () => {
    const store = setup()
    expect(store.add('missing', range)).toBe(false)
    expect(store.add('App.vue', { ...range, endLine: 10 })).toBe(false)
    expect(store.add('App.vue', { ...range, endColumn: 100 })).toBe(false)
    useArtifactStore().loading = true
    expect(store.add('App.vue', range)).toBe(false)
    useArtifactStore().loading = false
    useArtifactStore().editFile('theme.css', 'draft')
    expect(store.add('App.vue', range)).toBe(false)
  })
})
