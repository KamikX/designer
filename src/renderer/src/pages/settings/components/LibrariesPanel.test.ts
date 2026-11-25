// @vitest-environment happy-dom
import { flushPromises, shallowMount } from '@vue/test-utils'
import { App } from 'antdv-next'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import LibrariesPanel from './LibrariesPanel.vue'
import type { ExternalLibraryRef, InstalledLibrary } from '@shared/types'

const lib: InstalledLibrary = {
  name: 'tailwind-variants',
  version: '3.2.2',
  stacks: ['vue3', 'react'],
  description: 'Variants',
  instructions: 'Use tv()',
  subpaths: [],
  css: [],
  id: 'library',
  installedAt: new Date().toISOString(),
  entries: { 'tailwind-variants': 'entry.js' },
  styles: [],
  files: ['entry.js'],
  ready: true
}
const update = vi.fn(
  async (ref: ExternalLibraryRef, patch: { description: string; instructions: string }) => {
    // Electron IPC rejects Vue proxies via the same structured clone algorithm.
    structuredClone(ref)
    structuredClone(patch)
  }
)
const remove = vi.fn(async (ref: ExternalLibraryRef) => {
  structuredClone(ref)
})
const install = vi.fn(async (input: unknown) => structuredClone(input))
const error = vi.fn()
beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(App, 'useApp').mockReturnValue({
    message: { success: vi.fn(), error }
  } as unknown as ReturnType<typeof App.useApp>)
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      libraries: {
        list: vi.fn(async () => [lib]),
        update,
        install,
        remove,
        onProgress: () => () => {}
      }
    }
  })
})
afterEach(() => vi.restoreAllMocks())
const panel = (): ReturnType<typeof shallowMount> =>
  shallowMount(LibrariesPanel, { global: { renderStubDefaultSlot: true } })

describe('library management IPC payloads', () => {
  it('saves edited instructions using a cloneable reference rather than the reactive library', async () => {
    const wrapper = panel()
    await flushPromises()
    wrapper
      .findAllComponents({ name: 'AButton' })
      .find((button) => button.text() === '编辑说明')!
      .vm.$emit('click')
    await flushPromises()
    wrapper.findComponent({ name: 'AModal' }).vm.$emit('ok')
    await flushPromises()
    expect(update).toHaveBeenCalledWith(
      { name: lib.name, version: lib.version },
      { description: lib.description, instructions: lib.instructions }
    )
    expect(error).not.toHaveBeenCalled()
    expect(wrapper.findComponent({ name: 'AModal' }).props('open')).toBe(false)
  })
  it('reinstalls an existing version with cloneable configuration to refresh its exports', async () => {
    const wrapper = panel()
    await flushPromises()
    wrapper
      .findAllComponents({ name: 'AButton' })
      .find((button) => button.text() === '重新安装')!
      .vm.$emit('click')
    await flushPromises()
    wrapper.findComponent({ name: 'AModal' }).vm.$emit('ok')
    await flushPromises()
    expect(install).toHaveBeenCalledWith({
      name: lib.name,
      version: lib.version,
      stacks: lib.stacks,
      description: lib.description,
      instructions: lib.instructions,
      subpaths: [],
      css: []
    })
    expect(error).not.toHaveBeenCalled()
  })
  it('uninstalls a listed reactive library using only cloneable name and version fields', async () => {
    const wrapper = panel()
    await flushPromises()
    wrapper.findComponent({ name: 'APopconfirm' }).vm.$emit('confirm')
    await flushPromises()
    expect(remove).toHaveBeenCalledWith({ name: lib.name, version: lib.version })
    expect(error).not.toHaveBeenCalled()
  })
})
