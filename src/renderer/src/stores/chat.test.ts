// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useChatStore } from './chat'
import { useArtifactStore } from './artifact'

/**
 * 工具活动相位的聚焦测试:tool-input-start → preparing,
 * 本地执行开始(tool-exec)→ executing,终态四分。
 *
 * 流条目挂在**非当前会话**上:handleEvent 对当前会话会转发文件事件给
 * artifact store,这里只测活动相位,不把画布拖下水。
 */

function seedStream(store: ReturnType<typeof useChatStore>): void {
  store.streams['c-background'] = {
    streamId: 's1',
    conversationId: 'c-background',
    assistantMessageId: 'm1',
    parts: [],
    activities: [],
    reasoning: ''
  }
}

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('工具活动相位', () => {
  it('tool-start 是 preparing,tool-exec 翻到 executing 并换标签', () => {
    const store = useChatStore()
    seedStream(store)

    store.handleEvent({
      streamId: 's1',
      type: 'tool-start',
      callId: 't1',
      toolName: 'apply_patch',
      label: '准备补丁'
    })
    const activity = store.streams['c-background'].activities[0]
    expect(activity.state).toBe('preparing')
    expect(activity.label).toBe('准备补丁')

    store.handleEvent({ streamId: 's1', type: 'tool-exec', callId: 't1', label: '执行补丁' })
    expect(activity.state).toBe('executing')
    expect(activity.label).toBe('执行补丁')
  })

  it('终态:成功 / 可恢复失败 / 最终失败带耗时', () => {
    const store = useChatStore()
    seedStream(store)
    for (const id of ['t1', 't2', 't3']) {
      store.handleEvent({
        streamId: 's1',
        type: 'tool-start',
        callId: id,
        toolName: 'edit_file',
        label: '准备编辑'
      })
    }

    store.handleEvent({
      streamId: 's1',
      type: 'tool-end',
      callId: 't1',
      ok: true,
      status: 'success',
      execMs: 42
    })
    store.handleEvent({
      streamId: 's1',
      type: 'tool-end',
      callId: 't2',
      ok: false,
      status: 'recoverable_error',
      summary: '旧文本不匹配'
    })
    store.handleEvent({
      streamId: 's1',
      type: 'tool-end',
      callId: 't3',
      ok: false,
      status: 'fatal_error',
      execMs: 800
    })

    const [a, b, c] = store.streams['c-background'].activities
    expect(a.state).toBe('success')
    expect(a.execMs).toBe(42)
    expect(b.state).toBe('recoverable_error')
    expect(c.state).toBe('fatal_error')
    expect(c.execMs).toBe(800)
  })

  it('老主进程不带 status 时按 ok 退化', () => {
    const store = useChatStore()
    seedStream(store)
    store.handleEvent({
      streamId: 's1',
      type: 'tool-start',
      callId: 't1',
      toolName: 'read_file',
      label: '读取'
    })
    store.handleEvent({ streamId: 's1', type: 'tool-end', callId: 't1', ok: false })
    expect(store.streams['c-background'].activities[0].state).toBe('recoverable_error')
  })

  it('流出错时进行中的活动标记为 aborted', () => {
    const store = useChatStore()
    seedStream(store)
    store.handleEvent({
      streamId: 's1',
      type: 'tool-start',
      callId: 't1',
      toolName: 'write_file',
      label: '准备写入'
    })
    const activities = store.streams['c-background'].activities

    store.handleEvent({ streamId: 's1', type: 'error', message: '上游 502' })
    expect(activities[0].state).toBe('aborted')
  })
})

/**
 * 纯聊天设置的持久化。起始页故意不建会话,曾经导致那里做的所有选择
 * (模型/技能/MCP/联网)在 persistSettings 里因为没有归属而被静默丢弃
 * ——重开会话模型就没了。ensureChat 必须在会话落库后补写。
 */
describe('纯聊天设置持久化', () => {
  function stubApi(saved: [string, unknown][]): void {
    Object.assign(window, {
      api: {
        chat: {
          listMessages: async () => [],
          onStream: () => () => {}
        },
        chatSession: {
          create: async () => ({ id: 'c-new' }),
          saveSettings: async (id: string, patch: unknown) => {
            saved.push([id, patch])
          }
        }
      }
    })
  }

  it('ensureChat 建会话后补写起始页里做的选择', async () => {
    const saved: [string, unknown][] = []
    stubApi(saved)
    const store = useChatStore()
    store.selected = { providerId: 'p1', modelId: 'm1' }
    store.skillIds = ['antdv-next']
    store.mcpIds = ['fetch']
    store.webSearch = true

    await store.ensureChat()

    expect(store.conversationId).toBe('c-new')
    expect(saved).toEqual([
      [
        'c-new',
        {
          providerId: 'p1',
          modelId: 'm1',
          skillIds: ['antdv-next'],
          mcpIds: ['fetch'],
          webSearch: true
        }
      ]
    ])
  })

  it('起始页什么都没选:不发空补丁', async () => {
    const saved: [string, unknown][] = []
    stubApi(saved)
    const store = useChatStore()

    await store.ensureChat()

    expect(saved).toEqual([])
  })

  it('openProject 无条件覆盖 webSearch:恢复存档,或清掉上一会话漏过来的', () => {
    const store = useChatStore()
    store.webSearch = true
    store.openProject({ id: 'p-a', settings: {} } as never)
    expect(store.webSearch).toBe(false)

    store.openProject({ id: 'p-b', settings: { webSearch: true } } as never)
    expect(store.webSearch).toBe(true)
  })
})

describe('version-aware send', () => {
  function setup(): {
    chat: ReturnType<typeof useChatStore>
    artifact: ReturnType<typeof useArtifactStore>
    send: ReturnType<typeof vi.fn>
  } {
    const chat = useChatStore()
    const artifact = useArtifactStore()
    chat.projectId = 'p'
    chat.conversationId = 'c'
    chat.selected = { providerId: 'provider', modelId: 'model' }
    artifact.projectId = 'p'
    artifact.currentId = 'old'
    artifact.artifacts = [
      {
        id: 'old',
        projectId: 'p',
        messageId: null,
        version: 1,
        baseArtifactId: null,
        summary: '',
        createdAt: ''
      }
    ]
    const send = vi
      .fn()
      .mockResolvedValue({ streamId: 's', userMessageId: 'u', assistantMessageId: 'a' })
    Object.defineProperty(window, 'api', { configurable: true, value: { chat: { send } } })
    return { chat, artifact, send }
  }

  it('passes the displayed version as the next edit base', async () => {
    const { chat, send } = setup()
    await chat.send('Edit')
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ baseArtifactId: 'old' }))
  })

  it('blocks sending while files load or the canvas belongs to another project', async () => {
    const { chat, artifact, send } = setup()
    artifact.loading = true
    await chat.send('Edit')
    artifact.loading = false
    artifact.projectId = 'other'
    await chat.send('Edit')
    expect(send).not.toHaveBeenCalled()
  })

  it('blocks duplicate submissions before IPC returns', async () => {
    const { chat, send } = setup()
    let resolve!: (result: unknown) => void
    send.mockReturnValue(
      new Promise((r) => {
        resolve = r
      })
    )
    const first = chat.send('Edit')
    expect(chat.sending).toBe(true)
    await chat.send('Another edit')
    expect(send).toHaveBeenCalledTimes(1)
    resolve({ streamId: 's', userMessageId: 'u', assistantMessageId: 'a' })
    await first
    expect(chat.sending).toBe(false)
  })

  it('keeps plain chat independent of the displayed project snapshot', async () => {
    const { chat, send } = setup()
    chat.projectId = ''
    await chat.send('Hello')
    expect(send.mock.calls[0][0]).not.toHaveProperty('baseArtifactId')
  })
})

describe('message deletion', () => {
  function setupDeletion(): {
    store: ReturnType<typeof useChatStore>
    remove: ReturnType<typeof vi.fn>
  } {
    const store = useChatStore()
    store.conversationId = 'c'
    store.messages = ['a', 'b'].map((id) => ({
      id,
      conversationId: 'c',
      role: 'user',
      parts: [{ type: 'text', text: id }],
      status: 'complete',
      usage: null,
      providerSlug: null,
      modelId: null,
      artifactId: null,
      author: null,
      createdAt: ''
    }))
    const remove = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { chat: { deleteMessages: remove, send: vi.fn() } }
    })
    return { store, remove }
  }

  it('updates visible messages and transient data only after successful persistence', async () => {
    const { store, remove } = setupDeletion()
    let finish!: () => void
    remove.mockReturnValue(
      new Promise<void>((resolve) => {
        finish = resolve
      })
    )
    store.activities.a = []
    store.reasoning.a = 'reasoning'
    const pending = store.deleteMessages('c', ['a'])
    expect(store.messages).toHaveLength(2)
    expect(store.deleting).toBe(true)
    finish()
    await pending
    expect(remove).toHaveBeenCalledWith({ conversationId: 'c', messageIds: ['a'] })
    expect(store.messages.map((message) => message.id)).toEqual(['b'])
    expect(store.activities.a).toBeUndefined()
    expect(store.reasoning.a).toBeUndefined()
    expect(store.deleting).toBe(false)
  })

  it('preserves messages and transient data on failure', async () => {
    const { store, remove } = setupDeletion()
    remove.mockRejectedValue(new Error('failure'))
    store.reasoning.a = 'keep'
    await expect(store.deleteMessages('c', ['a'])).rejects.toThrow('failure')
    expect(store.messages).toHaveLength(2)
    expect(store.reasoning.a).toBe('keep')
    expect(store.deleting).toBe(false)
  })

  it('does not modify another conversation when deletion completes in the background', async () => {
    const { store, remove } = setupDeletion()
    let finish!: () => void
    remove.mockReturnValue(
      new Promise<void>((resolve) => {
        finish = resolve
      })
    )
    const pending = store.deleteMessages('c', ['a'])
    store.conversationId = 'other'
    const current = [...store.messages]
    store.messages = current
    finish()
    await pending
    expect(store.messages).toHaveLength(2)
    expect(store.deletingConversations).toEqual([])
  })

  it('blocks deletion during submission, streaming and another deletion, and blocks sending during deletion', async () => {
    const { store, remove } = setupDeletion()
    store.sendingConversations = ['c']
    await expect(store.deleteMessages('c', ['a'])).rejects.toThrow()
    store.sendingConversations = []
    seedStream(store)
    store.streams.c = { ...store.streams['c-background'], conversationId: 'c' }
    await expect(store.deleteMessages('c', ['a'])).rejects.toThrow()
    store.streams = {}
    store.deletingConversations = ['c']
    await expect(store.deleteMessages('c', ['a'])).rejects.toThrow()
    store.selected = { providerId: 'p', modelId: 'm' }
    await store.send('new message')
    expect(window.api.chat.send).not.toHaveBeenCalled()
    expect(remove).not.toHaveBeenCalled()
  })
})
