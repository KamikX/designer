// @vitest-environment happy-dom

import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useChatStore } from './chat'

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
