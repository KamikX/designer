// @vitest-environment happy-dom
import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { reactive } from 'vue'
import LibraryPicker from './LibraryPicker.vue'
import type { InstalledLibrary } from '@shared/types'

const library = (
  version: string,
  stacks: InstalledLibrary['stacks'] = ['vue3', 'react']
): InstalledLibrary => ({
  name: 'zod',
  version,
  stacks,
  description: 'Validation',
  instructions: '',
  subpaths: [],
  css: [],
  id: version,
  installedAt: new Date().toISOString(),
  entries: { zod: 'entry.js' },
  styles: [],
  files: ['entry.js'],
  ready: true
})
beforeEach(() => {
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      libraries: {
        list: vi.fn(async () => [
          library('4.4.2'),
          library('4.4.3'),
          { ...library('1.0.0', ['vue3']), name: 'vue-only' }
        ])
      }
    }
  })
})
const mountPicker = (refs = [{ name: 'zod', version: '4.4.2' }]): ReturnType<typeof mount> =>
  mount(LibraryPicker, {
    props: { stack: 'react', modelValue: refs },
    global: { stubs: { ACheckbox: true, ASpin: true, AAlert: true } }
  })
describe('project library selection', () => {
  it('replaces a selected version with exactly one update and hides incompatible libraries', async () => {
    const wrapper = mountPicker()
    await flushPromises()
    expect(wrapper.text()).not.toContain('vue-only')
    wrapper.findAllComponents({ name: 'ACheckbox' })[1].vm.$emit('change')
    expect(wrapper.emitted('update:modelValue')).toEqual([[[{ name: 'zod', version: '4.4.3' }]]])
  })
  it('allows removing a missing reference', async () => {
    const wrapper = mountPicker([{ name: 'removed-package', version: '1.0.0' }])
    await flushPromises()
    expect(wrapper.text()).toContain('removed-package')
    wrapper.findAllComponents({ name: 'ACheckbox' }).at(-1)!.vm.$emit('change')
    expect(wrapper.emitted('update:modelValue')).toEqual([[[]]])
  })
  it('keeps surviving selections cloneable when adding another library', async () => {
    const wrapper = mountPicker(reactive([{ name: 'existing-library', version: '1.0.0' }]))
    await flushPromises()
    wrapper.findAllComponents({ name: 'ACheckbox' })[1].vm.$emit('change')
    const refs = wrapper.emitted('update:modelValue')![0][0]
    expect(structuredClone(refs)).toEqual([
      { name: 'existing-library', version: '1.0.0' },
      { name: 'zod', version: '4.4.3' }
    ])
  })
})
