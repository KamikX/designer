// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { useArtifactStore } from '@renderer/stores/artifact'
import { useChatStore } from '@renderer/stores/chat'
import VersionPicker from './VersionPicker.vue'

beforeEach(() => {
  setActivePinia(createPinia())
})

function mountPicker(): ReturnType<typeof mount> {
  return mount(VersionPicker, {
    props: { projectId: 'p' },
    global: {
      stubs: {
        APopover: { template: '<div><slot /><slot name="content" /></div>' },
        AButton: { template: '<button><slot /></button>' },
        DownOutlined: true
      }
    }
  })
}

function seed(): ReturnType<typeof useArtifactStore> {
  const store = useArtifactStore()
  store.projectId = 'p'
  store.artifacts = [2, 1].map((version) => ({
    id: `v${version}`,
    version,
    projectId: 'p',
    messageId: null,
    baseArtifactId: null,
    summary: `Summary ${version}`,
    createdAt: '2026-11-24 10:00:00'
  }))
  store.currentId = 'v2'
  return store
}

describe('version picker', () => {
  it('hides the control for a project without versions', () => {
    expect(mountPicker().find('button').exists()).toBe(false)
  })

  it('selects an older snapshot and indicates the next edit base', async () => {
    const store = seed()
    const files = vi.fn().mockResolvedValue([{ path: 'index.html', content: 'old' }])
    Object.defineProperty(window, 'api', { configurable: true, value: { artifact: { files } } })
    const wrapper = mountPicker()
    expect(wrapper.findAll('.version-option').map((item) => item.text())).toEqual([
      expect.stringContaining('Summary 2'),
      expect.stringContaining('Summary 1')
    ])
    await wrapper.findAll('.version-option')[1].trigger('click')
    await flushPromises()
    expect(files).toHaveBeenCalledWith('v1')
    expect(store.currentId).toBe('v1')
    expect(wrapper.find('.version-hint').text()).toContain('v1')
    expect(wrapper.findAll('.version-option')[1].attributes('aria-pressed')).toBe('true')
  })

  it('blocks switching during submission, streaming and snapshot loading', async () => {
    seed()
    const chat = useChatStore()
    chat.projectId = 'p'
    chat.conversationId = 'c'
    const wrapper = mountPicker()
    for (const phase of ['sending', 'streaming', 'loading']) {
      chat.sendingConversations = phase === 'sending' ? ['c'] : []
      chat.streams =
        phase === 'streaming'
          ? {
              c: {
                streamId: 's',
                projectId: 'p',
                conversationId: 'c',
                assistantMessageId: 'a',
                parts: [],
                activities: [],
                reasoning: ''
              }
            }
          : {}
      useArtifactStore().loading = phase === 'loading'
      await flushPromises()
      expect(
        wrapper
          .findAll('.version-option')
          .every((item) => item.attributes('disabled') !== undefined)
      ).toBe(true)
    }
  })
})
