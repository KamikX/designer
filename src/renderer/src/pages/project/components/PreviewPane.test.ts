// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { enableAutoUnmount, flushPromises, shallowMount } from '@vue/test-utils'
import type { VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { useArtifactStore } from '@renderer/stores/artifact'
import { useAnnotationStore } from '@renderer/stores/annotation'
import PreviewPane from './PreviewPane.vue'

enableAutoUnmount(afterEach)

const warning = vi.hoisted(() => vi.fn())
vi.mock('antdv-next', async (importOriginal) => ({
  ...(await importOriginal<typeof import('antdv-next')>()),
  App: { useApp: () => ({ message: { warning } }) }
}))

beforeEach(() => {
  setActivePinia(createPinia())
  warning.mockClear()
  vi.spyOn(HTMLIFrameElement.prototype, 'contentWindow', 'get').mockReturnValue(window)
})

afterEach(() => vi.restoreAllMocks())

function setup(stack: 'vue3' | 'html' | 'react' = 'vue3'): {
  wrapper: VueWrapper<InstanceType<typeof PreviewPane>>
  store: ReturnType<typeof useArtifactStore>
  annotation: ReturnType<typeof useAnnotationStore>
  send: (type: string, source?: unknown, fromFrame?: boolean) => void
} {
  const store = useArtifactStore()
  store.projectId = 'p'
  store.currentId = 'v1'
  store.artifacts = []
  store.files = [{ path: 'shared/components/PageHeader.vue', content: '<template />' }]
  const target = document.createElement('div')
  const wrapper = shallowMount(PreviewPane, {
    props: { stack, actionsTarget: target },
    global: {
      stubs: {
        teleport: true,
        ATooltip: { template: '<div><slot /></div>' },
        AModal: { template: '<div />' }
      }
    }
  })
  const annotation = useAnnotationStore()
  const frame = wrapper.find('iframe').element as HTMLIFrameElement
  function send(type: string, source?: unknown, fromFrame = true): void {
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { __preview: true, type, source },
        source: fromFrame ? frame.contentWindow : null
      })
    )
  }
  return { wrapper, store, annotation, send }
}

describe('preview source selection', () => {
  it('opens a valid source without creating an annotation', async () => {
    const { wrapper, annotation, send } = setup()
    await wrapper.findAllComponents({ name: 'AButton' })[1].trigger('click')
    send('source:pick', 'shared/components/PageHeader.vue:8:3')
    expect(wrapper.emitted('openSource')).toEqual([
      [
        {
          path: 'shared/components/PageHeader.vue',
          line: 8,
          column: 3
        }
      ]
    ])
    expect(annotation.marks).toHaveLength(0)
    send('source:pick', 'shared/components/PageHeader.vue:8:3')
    expect(wrapper.emitted('openSource')).toHaveLength(1)
    wrapper.unmount()
  })

  it.each([
    '',
    'missing.vue:8:3',
    'shared/components/PageHeader.vue:0:3',
    'shared/components/PageHeader.vue:8:-1',
    null
  ])('rejects invalid or missing source %s and allows another selection', async (source) => {
    const { wrapper, send } = setup()
    await wrapper.findAllComponents({ name: 'AButton' })[1].trigger('click')
    send('source:pick', source)
    expect(wrapper.emitted('openSource')).toBeUndefined()
    expect(warning).toHaveBeenCalledOnce()
    send('source:pick', 'shared/components/PageHeader.vue:8:3')
    expect(wrapper.emitted('openSource')).toHaveLength(1)
    wrapper.unmount()
  })

  it('ignores foreign messages, cancels with Escape and resets on version changes', async () => {
    const { wrapper, store, send } = setup()
    const button = wrapper.findAllComponents({ name: 'AButton' })[1]
    await button.trigger('click')
    send('source:pick', 'shared/components/PageHeader.vue:8:3', false)
    expect(wrapper.emitted('openSource')).toBeUndefined()
    send('source:cancel')
    send('source:pick', 'shared/components/PageHeader.vue:8:3')
    expect(wrapper.emitted('openSource')).toBeUndefined()
    await button.trigger('click')
    store.currentId = 'v2'
    await flushPromises()
    send('source:pick', 'shared/components/PageHeader.vue:8:3')
    expect(wrapper.emitted('openSource')).toBeUndefined()
    wrapper.unmount()
  })

  it('keeps annotations while switching mutually exclusive modes', async () => {
    const { wrapper, annotation, send } = setup()
    annotation.marks = [{ id: 'saved', target: { selector: 'button' } }] as typeof annotation.marks
    const buttons = wrapper.findAllComponents({ name: 'AButton' })
    await buttons[0].trigger('click')
    expect(annotation.enabled).toBe(true)
    await buttons[1].trigger('click')
    expect(annotation.enabled).toBe(false)
    await buttons[0].trigger('click')
    expect(annotation.enabled).toBe(true)
    send('source:pick', 'shared/components/PageHeader.vue:8:3')
    expect(wrapper.emitted('openSource')).toBeUndefined()
    expect(annotation.marks).toHaveLength(1)
    wrapper.unmount()
  })

  it.each(['html', 'react'] as const)('disables source picking for %s', (stack) => {
    const { wrapper } = setup(stack)
    expect(wrapper.findAllComponents({ name: 'AButton' })[1].attributes('disabled')).toBeDefined()
    wrapper.unmount()
  })
})
