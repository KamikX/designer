// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { shallowMount, flushPromises } from '@vue/test-utils'
import type { VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { App } from 'antdv-next'
import { useChatStore } from '@renderer/stores/chat'
import { useAnnotationStore } from '@renderer/stores/annotation'
import type { MarkTarget } from '@renderer/stores/annotation'
import Composer from './Composer.vue'
import { useArtifactStore } from '@renderer/stores/artifact'
import { useCodeSelectionStore } from '@renderer/stores/code-selection'

const confirmEdits = vi.hoisted(() => vi.fn())
vi.mock('@renderer/composables/useCodeEdits', () => ({ useCodeEdits: () => ({ confirmEdits }) }))
vi.mock('@renderer/stores/provider', () => ({
  useProviderStore: () => ({
    chatModels: [{ models: [{ id: 'model', abilities: ['vision'] }] }]
  })
}))

beforeEach(() => {
  setActivePinia(createPinia())
  confirmEdits.mockReset().mockResolvedValue(false)
  vi.spyOn(App, 'useApp').mockReturnValue({
    message: { error: vi.fn(), warning: vi.fn() }
  } as unknown as ReturnType<typeof App.useApp>)
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      mcp: { list: vi.fn().mockResolvedValue({ servers: [] }) },
      market: { installedSkills: vi.fn().mockResolvedValue([]) },
      storage: {
        importImage: vi
          .fn()
          .mockResolvedValue({ id: 'image', uri: 'asset://image', mime: 'image/png' })
      }
    }
  })
})

describe('sending with unsaved code', () => {
  it('preserves text, image attachments and annotations on cancel, then sends them on approval', async () => {
    const chat = useChatStore()
    chat.projectId = 'p'
    chat.selected = { providerId: 'provider', modelId: 'model' }
    const annotation = useAnnotationStore()
    annotation.add(
      {
        tag: 'button',
        text: 'Action',
        classes: [],
        attrs: {},
        source: '',
        path: 'button',
        html: '<button>Action</button>',
        selector: 'button',
        id: '',
        rect: { x: 0, y: 0, w: 20, h: 20 }
      } as MarkTarget,
      'Change this'
    )
    const wrapper = shallowMount(Composer, {
      global: {
        stubs: {
          ATextarea: {
            props: ['value'],
            emits: ['update:value'],
            template:
              '<textarea :value="value" @input="$emit(\'update:value\', $event.target.value)" />'
          },
          ATooltip: { template: '<div><slot /></div>' },
          AButton: { template: '<button><slot /></button>' }
        }
      }
    })
    await flushPromises()
    await wrapper.get('textarea').setValue('Update the page')
    const image = new File(['test'], 'test.png', { type: 'image/png' })
    await wrapper.get('.composer').trigger('drop', { dataTransfer: { files: [image] } })
    await flushPromises()
    expect(wrapper.find('.composer-thumb').exists()).toBe(true)
    await wrapper.get('.composer-send').trigger('click')
    await flushPromises()
    expect(wrapper.emitted('send')).toBeUndefined()
    expect((wrapper.get('textarea').element as HTMLTextAreaElement).value).toBe('Update the page')
    expect(wrapper.find('.composer-thumb').exists()).toBe(true)
    expect(annotation.marks).toHaveLength(1)
    confirmEdits.mockResolvedValue(true)
    await wrapper.get('.composer-send').trigger('click')
    await flushPromises()
    const sent = wrapper.emitted('send')![0]
    expect(sent[0]).toContain('Update the page')
    expect(sent[0]).toContain('Change this')
    expect(sent[1]).toEqual([expect.objectContaining({ assetId: 'image' })])
    expect(annotation.marks).toEqual([])
    expect(wrapper.find('.composer-thumb').exists()).toBe(false)
    wrapper.unmount()
  })
})

function annotationComposer(note: string): {
  wrapper: VueWrapper<InstanceType<typeof Composer>>
  annotation: ReturnType<typeof useAnnotationStore>
} {
  useChatStore().projectId = 'p'
  const annotation = useAnnotationStore()
  annotation.add(
    {
      tag: 'button',
      text: 'Action',
      classes: [],
      attrs: {},
      source: '',
      path: 'button',
      html: '<button>Action</button>',
      selector: 'button',
      id: '',
      rect: { x: 0, y: 0, w: 20, h: 20 }
    },
    note
  )
  const wrapper = shallowMount(Composer, {
    global: {
      stubs: {
        ATextarea: {
          props: ['value'],
          emits: ['update:value'],
          template:
            '<textarea :value="value" @input="$emit(\'update:value\', $event.target.value)" />'
        },
        ATooltip: { template: '<div><slot /></div>' },
        AButton: {
          props: ['disabled'],
          template: '<button :disabled="disabled"><slot /></button>'
        },
        AModal: {
          name: 'AModal',
          props: ['open'],
          template: '<section v-if="open"><slot /></section>'
        }
      }
    }
  })
  return { wrapper, annotation }
}

describe('annotation-only messages', () => {
  it.each(['click', 'enter'])('sends described annotations using %s', async (method) => {
    confirmEdits.mockResolvedValue(true)
    const { wrapper, annotation } = annotationComposer('Make larger')
    await flushPromises()
    expect(wrapper.get('.composer-send').attributes('disabled')).toBeUndefined()
    if (method === 'click') await wrapper.get('.composer-send').trigger('click')
    else await wrapper.get('textarea').trigger('keydown', { key: 'Enter' })
    await flushPromises()
    expect(wrapper.emitted('send')?.[0][0]).toContain('Make larger')
    expect(annotation.marks).toEqual([])
    wrapper.unmount()
  })

  it.each(['', '   '])(
    'blocks missing descriptions (%s) and supports editing before retry',
    async (note) => {
      confirmEdits.mockResolvedValue(true)
      const { wrapper, annotation } = annotationComposer(note)
      await wrapper.get('.composer-send').trigger('click')
      expect(wrapper.emitted('send')).toBeUndefined()
      expect(confirmEdits).not.toHaveBeenCalled()
      expect(wrapper.find('.annotation-warning-row').exists()).toBe(true)
      await wrapper.get('.annotation-warning-row .composer-mark-edit').trigger('click')
      annotation.editorNote = 'Fixed description'
      annotation.saveEditor()
      await flushPromises()
      expect(wrapper.emitted('send')).toBeUndefined()
      await wrapper.get('.composer-send').trigger('click')
      await flushPromises()
      expect(wrapper.emitted('send')?.[0][0]).toContain('Fixed description')
      wrapper.unmount()
    }
  )

  it('allows missing descriptions when chat has instructions', async () => {
    confirmEdits.mockResolvedValue(true)
    const { wrapper } = annotationComposer('')
    await wrapper.get('textarea').setValue('Update marked elements')
    await wrapper.get('.composer-send').trigger('click')
    await flushPromises()
    expect(wrapper.emitted('send')?.[0][0]).toContain('Update marked elements')
    wrapper.unmount()
  })

  it('revalidates descriptions after confirming code edits', async () => {
    const { wrapper, annotation } = annotationComposer('Original')
    confirmEdits.mockImplementation(async () => {
      annotation.marks[0].note = ' '
      return true
    })
    await wrapper.get('.composer-send').trigger('click')
    await flushPromises()
    expect(wrapper.emitted('send')).toBeUndefined()
    expect(annotation.marks).toHaveLength(1)
    expect(wrapper.find('.annotation-warning-row').exists()).toBe(true)
    wrapper.unmount()
  })
})

it('preserves incomplete annotations on dialog cancel and removes them explicitly', async () => {
  const { wrapper, annotation } = annotationComposer('')
  await wrapper.get('.composer-send').trigger('click')
  const warningModal = wrapper.findAllComponents({ name: 'AModal' })[0]
  warningModal.vm.$emit('cancel')
  await flushPromises()
  expect(annotation.marks).toHaveLength(1)
  expect(wrapper.find('.annotation-warning-row').exists()).toBe(false)
  await wrapper.get('.composer-send').trigger('click')
  await wrapper.get('.annotation-warning-row button:last-child').trigger('click')
  expect(annotation.marks).toEqual([])
  expect(wrapper.emitted('send')).toBeUndefined()
  wrapper.unmount()
})

function addCodeContext(): ReturnType<typeof useCodeSelectionStore> {
  const artifact = useArtifactStore()
  artifact.projectId = 'p'
  artifact.currentId = 'v1'
  artifact.files = [{ path: 'App.vue', content: 'private source code' }]
  const selections = useCodeSelectionStore()
  expect(
    selections.add('App.vue', { startLine: 1, startColumn: 2, endLine: 1, endColumn: 6 })
  ).toBe(true)
  return selections
}

describe('code context messages', () => {
  it('sends positions alongside annotations and clears only sent context', async () => {
    const { wrapper } = annotationComposer('Change element')
    const selections = addCodeContext()
    await flushPromises()
    expect(wrapper.find('.composer-code-selections').exists()).toBe(true)
    confirmEdits.mockResolvedValue(true)
    await wrapper.get('.composer-send').trigger('click')
    await flushPromises()
    const body = wrapper.emitted('send')![0][0] as string
    expect(body).toContain('Change element')
    expect(body).toContain('App.vue:1:2–1:6')
    expect(body).not.toContain('private source code')
    expect(selections.selections).toEqual([])
    wrapper.unmount()
  })
  it('requires instructions and supports removing a chip', async () => {
    const { wrapper, annotation } = annotationComposer('')
    annotation.clear()
    const selections = addCodeContext()
    await flushPromises()
    expect(wrapper.get('.composer-send').attributes('disabled')).toBeDefined()
    await wrapper.get('textarea').trigger('keydown', { key: 'Enter' })
    expect(confirmEdits).not.toHaveBeenCalled()
    await wrapper.get('.composer-code-selections .composer-file-remove').trigger('click')
    expect(selections.selections).toEqual([])
    wrapper.unmount()
  })
  it('preserves ranges and draft when confirmation is cancelled', async () => {
    const { wrapper } = annotationComposer('Change element')
    const selections = addCodeContext()
    await wrapper.get('textarea').setValue('Keep draft')
    await wrapper.get('.composer-send').trigger('click')
    await flushPromises()
    expect(selections.selections).toHaveLength(1)
    expect(wrapper.emitted('send')).toBeUndefined()
    expect((wrapper.get('textarea').element as HTMLTextAreaElement).value).toBe('Keep draft')
    wrapper.unmount()
  })
  it('blocks sending and preserves text if saving changes the version during confirmation', async () => {
    const { wrapper } = annotationComposer('Change element')
    addCodeContext()
    await wrapper.get('textarea').setValue('Keep draft')
    confirmEdits.mockImplementation(async () => {
      useArtifactStore().currentId = 'v2'
      return true
    })
    await wrapper.get('.composer-send').trigger('click')
    await flushPromises()
    expect(wrapper.emitted('send')).toBeUndefined()
    expect((wrapper.get('textarea').element as HTMLTextAreaElement).value).toBe('Keep draft')
    expect(App.useApp().message.warning).toHaveBeenCalledOnce()
    wrapper.unmount()
  })
  it('excludes project ranges from plain chat without clearing them', async () => {
    const { wrapper } = annotationComposer('Change element')
    const selections = addCodeContext()
    useChatStore().projectId = ''
    await wrapper.get('textarea').setValue('Plain chat')
    await flushPromises()
    expect(wrapper.find('.composer-code-selections').exists()).toBe(false)
    confirmEdits.mockResolvedValue(true)
    await wrapper.get('.composer-send').trigger('click')
    await flushPromises()
    expect(wrapper.emitted('send')![0][0]).toBe('Plain chat')
    expect(selections.selections).toHaveLength(1)
    wrapper.unmount()
  })
})

it('opens the full code context label without removing it or sending a message', async () => {
  const { wrapper } = annotationComposer('Change element')
  const selections = addCodeContext()
  await flushPromises()
  const label = wrapper.get('.composer-code-open')
  expect(label.text()).toBe('App.vue:1:2–1:6')
  await label.trigger('click')
  await label.trigger('click')
  expect(wrapper.emitted('openCodeSelection')).toEqual([
    [{ ...selections.selections[0] }],
    [{ ...selections.selections[0] }]
  ])
  expect(wrapper.emitted('send')).toBeUndefined()
  expect(selections.selections).toHaveLength(1)
  wrapper.unmount()
})
