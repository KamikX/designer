import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { MAX_MARKS, useAnnotationStore } from './annotation'
import type { MarkTarget } from './annotation'

const target = (selector = 'button'): MarkTarget => ({
  selector,
  tag: 'button',
  id: '',
  classes: [],
  text: 'Action',
  source: '',
  attrs: {},
  path: selector,
  html: '<button>Action</button>',
  rect: { x: 0, y: 0, w: 20, h: 20 }
})

beforeEach(() => setActivePinia(createPinia()))

describe('annotation editing', () => {
  it('edits existing selections at the limit without duplicating or renumbering', () => {
    const store = useAnnotationStore()
    for (let i = 0; i < MAX_MARKS; i++) store.add(target(`button:nth-child(${i + 1})`), 'Original')
    const first = { ...store.marks[0] }
    store.openEditor(first.target)
    store.editorNote = '  Updated  '
    store.saveEditor()
    expect(store.marks).toHaveLength(MAX_MARKS)
    expect(store.marks[0]).toMatchObject({ id: first.id, index: 1, note: 'Updated' })
    store.openEditor(target('new'))
    expect(store.editorTarget).toBeNull()
  })

  it('preserves the saved note on cancel and resets the editor on version changes', () => {
    const store = useAnnotationStore()
    store.syncArtifact('v1')
    store.add(target(), 'Original')
    store.openEditor(target())
    store.editorNote = 'Unsaved'
    store.closeEditor()
    expect(store.marks[0].note).toBe('Original')
    store.openEditor(target())
    store.syncArtifact('v2')
    expect(store.editorTarget).toBeNull()
    expect(store.marks).toEqual([])
  })

  it('closes a deleted annotation and keeps numbering continuous', () => {
    const store = useAnnotationStore()
    const first = store.add(target(), '')!
    store.add(target('a'), 'Link')
    store.openEditor(first.target)
    store.remove(first.id)
    expect(store.editorTarget).toBeNull()
    expect(store.marks[0].index).toBe(1)
  })
})
