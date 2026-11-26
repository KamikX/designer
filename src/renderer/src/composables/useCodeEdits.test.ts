// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { h } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { createRouter, createMemoryHistory, RouterView } from 'vue-router'
import { App } from 'antdv-next'
import { useArtifactStore } from '@renderer/stores/artifact'
import { useCodeEdits, useCodeEditNavigation } from './useCodeEdits'

type DialogOptions = Parameters<ReturnType<typeof App.useApp>['modal']['confirm']>[0]
let options: DialogOptions
const destroy = vi.fn()
const error = vi.fn()
let controls: ReturnType<typeof useCodeEdits>

beforeEach(() => {
  setActivePinia(createPinia())
  destroy.mockClear()
  error.mockClear()
  vi.spyOn(App, 'useApp').mockReturnValue({
    modal: {
      confirm: (value: DialogOptions) => {
        options = value
        return { destroy }
      }
    },
    message: { error }
  } as unknown as ReturnType<typeof App.useApp>)
})

function seed(): ReturnType<typeof useArtifactStore> {
  const store = useArtifactStore()
  store.projectId = 'p'
  store.currentId = 'v1'
  store.selectedPath = 'index.html'
  store.files = [{ path: 'index.html', content: 'old' }]
  store.editFile('index.html', 'new')
  return store
}

function mountControls(): ReturnType<typeof mount> {
  return mount({
    setup() {
      controls = useCodeEdits()
      return () => h('div')
    }
  })
}

async function chooseDiscard(): Promise<void> {
  const footer = options.footer as (...args: unknown[]) => ReturnType<typeof h>
  const node = footer(null, { OkBtn: 'button', CancelBtn: 'button' })
  const buttons = node.children as ReturnType<typeof h>[]
  buttons[1].props!.onClick()
  await flushPromises()
}

describe('unsaved code confirmation', () => {
  it('cancels without altering drafts', async () => {
    const store = seed()
    const wrapper = mountControls()
    const result = controls.confirmEdits()
    options.onCancel!()
    expect(await result).toBe(false)
    expect(store.selectedContent).toBe('new')
    wrapper.unmount()
  })

  it('discards only after explicitly choosing discard', async () => {
    const store = seed()
    const wrapper = mountControls()
    const result = controls.confirmEdits()
    await chooseDiscard()
    expect(await result).toBe(true)
    expect(store.dirty).toBe(false)
    expect(destroy).toHaveBeenCalled()
    wrapper.unmount()
  })

  it('waits for saving, preserves edits on failure, and allows retry', async () => {
    const store = seed()
    const wrapper = mountControls()
    const save = vi.spyOn(store, 'saveEdits').mockRejectedValueOnce(new Error('disk full'))
    const result = controls.confirmEdits()
    expect(controls.confirmEdits()).toBe(result)
    await expect(options.onOk!()).rejects.toThrow('disk full')
    expect(error).toHaveBeenCalled()
    expect(store.dirty).toBe(true)
    save.mockImplementation(async () => store.discardEdits())
    await options.onOk!()
    expect(await result).toBe(true)
    wrapper.unmount()
  })

  it('requires confirmation for the standalone discard button', () => {
    const store = seed()
    const wrapper = mountControls()
    controls.discard()
    expect(store.dirty).toBe(true)
    options.onOk!()
    expect(store.dirty).toBe(false)
    wrapper.unmount()
  })
})

describe('navigation and window close protection', () => {
  it('guards switching projects and leaving; protects native close with the same choices', async () => {
    const store = seed()
    const Page = {
      setup() {
        controls = useCodeEdits()
        useCodeEditNavigation(controls.confirmEdits)
        return () => h('div')
      }
    }
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: '/project/:id', component: Page },
        { path: '/', component: { render: () => h('div') } }
      ]
    })
    await router.push('/project/p')
    const wrapper = mount(RouterView, { global: { plugins: [router] } })
    const switching = router.push('/project/q')
    await flushPromises()
    options.onCancel!()
    await switching
    expect(router.currentRoute.value.params.id).toBe('p')
    expect(store.dirty).toBe(true)
    const close = vi.spyOn(window, 'close').mockImplementation(() => {})
    const event = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(true)
    options.onCancel!()
    await flushPromises()
    expect(close).not.toHaveBeenCalled()
    window.dispatchEvent(new Event('beforeunload', { cancelable: true }))
    await chooseDiscard()
    expect(close).toHaveBeenCalledOnce()
    store.editFile('index.html', 'another edit')
    const leaving = router.push('/')
    await flushPromises()
    await chooseDiscard()
    await leaving
    expect(router.currentRoute.value.path).toBe('/')
    wrapper.unmount()
  })
})
