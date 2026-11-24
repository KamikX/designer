// @vitest-environment happy-dom
import { flushPromises, shallowMount } from '@vue/test-utils'
import { App } from 'antdv-next'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import VisualGuidanceFields from './VisualGuidanceFields.vue'

const error = vi.fn()
beforeEach(() => {
  vi.spyOn(App, 'useApp').mockReturnValue({ message: { error } } as unknown as ReturnType<
    typeof App.useApp
  >)
})
afterEach(() => vi.restoreAllMocks())

function mountFields(document = ''): ReturnType<typeof shallowMount> {
  return shallowMount(VisualGuidanceFields, {
    props: { styleBrief: '', designDocument: document, priority: 'styleBrief' },
    global: { renderStubDefaultSlot: true }
  })
}
async function selectFile(
  wrapper: ReturnType<typeof mountFields>,
  name: string,
  content: string
): Promise<void> {
  const input = wrapper.find('input')
  Object.defineProperty(input.element, 'files', {
    configurable: true,
    value: [
      {
        name,
        size: content.length,
        arrayBuffer: async () => new TextEncoder().encode(content).buffer
      }
    ]
  })
  await input.trigger('change')
  await flushPromises()
}

describe('visual guidance fields', () => {
  it('keeps document and priority optional when no document exists', () => {
    const wrapper = mountFields()
    expect(wrapper.find('pre').exists()).toBe(false)
    expect(wrapper.findComponent({ name: 'ASegmented' }).exists()).toBe(false)
    wrapper.unmount()
  })
  it('imports and replaces a file as text, including literal markup', async () => {
    const wrapper = mountFields()
    await selectFile(wrapper, 'Brand.md', '# Brand\n<script>bad()</script>')
    expect(wrapper.emitted('update:designDocument')?.[0]).toEqual([
      '# Brand\n<script>bad()</script>'
    ])
    await wrapper.setProps({ designDocument: '# Brand\n<script>bad()</script>' })
    expect(wrapper.find('script').exists()).toBe(false)
    expect(wrapper.find('pre').text()).toContain('<script>')
    expect(wrapper.findComponent({ name: 'ASegmented' }).exists()).toBe(true)
    await selectFile(wrapper, 'Other.md', '# Other')
    expect(wrapper.emitted('update:designDocument')?.at(-1)).toEqual(['# Other'])
    expect(wrapper.emitted('loading')?.at(-1)).toEqual([false])
    wrapper.unmount()
  })
  it('removes a document and preserves it on failed import', async () => {
    const wrapper = mountFields('# Saved')
    await selectFile(wrapper, 'Invalid.txt', '# Invalid')
    expect(wrapper.emitted('update:designDocument')).toBeUndefined()
    const remove = wrapper
      .findAllComponents({ name: 'AButton' })
      .find((button) => button.text() === '移除')!
    remove.vm.$emit('click')
    expect(wrapper.emitted('update:designDocument')?.at(-1)).toEqual([''])
    wrapper.unmount()
  })
})
