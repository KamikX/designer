// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import type { VueWrapper, DOMWrapper } from '@vue/test-utils'
import { App } from 'antdv-next'
import { createPinia, setActivePinia } from 'pinia'
import { useChatStore } from '@renderer/stores/chat'
import { t } from '@renderer/i18n'
import MessageHistory from './MessageHistory.vue'

vi.mock('./MessageItem.vue', () => ({
  default: {
    props: ['message', 'deleteDisabled'],
    emits: ['delete'],
    template:
      '<div class="message"><span>{{ message.id }}</span><button class="delete-one" :disabled="deleteDisabled" @click="$emit(\'delete\')">Delete</button></div>'
  }
}))

const confirm = vi.fn()
const error = vi.fn()
let remove: ReturnType<typeof vi.fn>

beforeEach(() => {
  setActivePinia(createPinia())
  confirm.mockReset()
  error.mockReset()
  vi.spyOn(App, 'useApp').mockReturnValue({
    modal: { confirm },
    message: { error }
  } as unknown as ReturnType<typeof App.useApp>)
  remove = vi.fn().mockResolvedValue(undefined)
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { chat: { deleteMessages: remove } }
  })
  const chat = useChatStore()
  chat.conversationId = 'c'
  chat.messages = ['a', 'b'].map((id) => ({
    id,
    conversationId: 'c',
    role: id === 'a' ? 'user' : 'assistant',
    parts: [{ type: 'text', text: id }],
    status: 'complete',
    usage: null,
    providerSlug: null,
    modelId: null,
    artifactId: null,
    author: null,
    createdAt: ''
  }))
})

function renderHistory(): VueWrapper {
  return mount(MessageHistory, {
    global: {
      stubs: {
        AButton: { template: '<button><slot name="icon" /><slot /></button>' },
        ATooltip: { template: '<slot />' },
        ACheckbox: {
          props: ['checked', 'disabled', 'indeterminate'],
          emits: ['change'],
          template:
            '<label><input type="checkbox" :checked="checked" :disabled="disabled" @change="$emit(\'change\')" /><slot /></label>'
        }
      }
    }
  })
}

function button(
  wrapper: ReturnType<typeof renderHistory>,
  label: string
): DOMWrapper<HTMLButtonElement> {
  return wrapper
    .findAll('button')
    .find((item) => item.attributes('aria-label') === label || item.text() === label)!
}

async function selectAll(wrapper: ReturnType<typeof renderHistory>): Promise<void> {
  await button(wrapper, t('chatMessages.select')).trigger('click')
  await wrapper.find('input').setValue(true)
}

describe('message history controls', () => {
  it('uses accessible icon buttons and reveals the selection toolbar only on activation', async () => {
    const wrapper = renderHistory()
    const select = button(wrapper, t('chatMessages.select'))
    expect(select.text()).toBe('')
    expect(select.find('svg').exists()).toBe(true)
    expect(wrapper.find('.history-actions--selecting').exists()).toBe(false)
    expect(wrapper.find('input').exists()).toBe(false)
    await select.trigger('click')
    expect(wrapper.find('.history-actions--selecting').exists()).toBe(true)
    const cancel = button(wrapper, t('common.cancel'))
    expect(cancel.text()).toBe('')
    expect(cancel.find('svg').exists()).toBe(true)
    expect(button(wrapper, t('chatMessages.delete')).attributes('type')).toBe('text')
    await cancel.trigger('click')
    expect(wrapper.find('.history-actions--selecting').exists()).toBe(false)
    expect(button(wrapper, t('chatMessages.select')).exists()).toBe(true)
    wrapper.unmount()
  })

  it('requests confirmation for a single message and deletes only after confirming', async () => {
    const wrapper = renderHistory()
    await wrapper.findAll('.delete-one')[1].trigger('click')
    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({ title: t('chatMessages.confirm', 1) })
    )
    expect(remove).not.toHaveBeenCalled()
    expect(useChatStore().messages).toHaveLength(2)
    await confirm.mock.calls[0][0].onOk()
    expect(remove).toHaveBeenCalledWith({ conversationId: 'c', messageIds: ['b'] })
    expect(useChatStore().messages.map((message) => message.id)).toEqual(['a'])
    wrapper.unmount()
  })

  it('selects all messages and deletes the entire history in one request', async () => {
    const wrapper = renderHistory()
    await selectAll(wrapper)
    await button(wrapper, t('chatMessages.delete')).trigger('click')
    expect(confirm.mock.calls[0][0].title).toBe(t('chatMessages.confirm', 2))
    await confirm.mock.calls[0][0].onOk()
    await flushPromises()
    expect(remove).toHaveBeenCalledWith({ conversationId: 'c', messageIds: ['a', 'b'] })
    expect(wrapper.find('.message-history').exists()).toBe(false)
    wrapper.unmount()
  })

  it('supports an arbitrary subset and cancelling selection without deleting', async () => {
    const wrapper = renderHistory()
    await button(wrapper, t('chatMessages.select')).trigger('click')
    await wrapper.findAll('input')[1].setValue(true)
    await button(wrapper, t('common.cancel')).trigger('click')
    expect(wrapper.find('input').exists()).toBe(false)
    expect(remove).not.toHaveBeenCalled()
    await button(wrapper, t('chatMessages.select')).trigger('click')
    await wrapper.findAll('input')[2].setValue(true)
    await button(wrapper, t('chatMessages.delete')).trigger('click')
    await confirm.mock.calls[0][0].onOk()
    expect(remove).toHaveBeenCalledWith({ conversationId: 'c', messageIds: ['b'] })
    wrapper.unmount()
  })

  it('preserves the selection and shows the error when persistence fails', async () => {
    remove.mockRejectedValue(new Error('failure'))
    const wrapper = renderHistory()
    await selectAll(wrapper)
    await button(wrapper, t('chatMessages.delete')).trigger('click')
    await expect(confirm.mock.calls[0][0].onOk()).rejects.toThrow('failure')
    await flushPromises()
    expect(error).toHaveBeenCalledWith('failure')
    expect(
      wrapper.findAll('input').every((input) => (input.element as HTMLInputElement).checked)
    ).toBe(true)
    expect(useChatStore().messages).toHaveLength(2)
    wrapper.unmount()
  })

  it('clears selection and invalidates pending confirmations when switching conversations', async () => {
    const wrapper = renderHistory()
    await selectAll(wrapper)
    await button(wrapper, t('chatMessages.delete')).trigger('click')
    useChatStore().conversationId = 'other'
    await flushPromises()
    expect(wrapper.find('input').exists()).toBe(false)
    await confirm.mock.calls[0][0].onOk()
    expect(remove).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('disables controls during submission and deletion', async () => {
    const wrapper = renderHistory()
    const chat = useChatStore()
    for (const phase of ['sendingConversations', 'deletingConversations'] as const) {
      chat[phase] = ['c']
      await flushPromises()
      expect(
        wrapper.findAll('button').every((item) => item.attributes('disabled') !== undefined)
      ).toBe(true)
      chat[phase] = []
    }
    wrapper.unmount()
  })
})
