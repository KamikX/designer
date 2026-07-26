// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type {
  Conversation,
  DesignerApi,
  GroupMember,
  GroupMemberTemplate,
  GroupStreamEvent,
  Message
} from '@shared/types'
import { useCollabStore } from './collab'

const role: GroupMemberTemplate = {
  id: 'pm',
  name: '产品经理',
  color: '#e8662c',
  duty: '梳理需求',
  deliverable: '需求文档',
  persona: '你是产品经理'
}

const member: GroupMember = {
  ...role,
  id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
  modelRowId: 'model-row-1',
  skillIds: []
}

const group: Conversation = {
  id: 'group-1',
  projectId: null,
  title: '设计协作',
  kind: 'group',
  settings: { members: [member] },
  createdAt: '2026-07-26T00:00:00.000Z',
  updatedAt: '2026-07-26T00:00:00.000Z'
}

function assistantMessage(status: Message['status']): Message {
  return {
    id: 'message-1',
    conversationId: group.id,
    role: 'assistant',
    parts: [{ type: 'text', text: '已完成' }],
    status,
    usage: null,
    providerSlug: null,
    modelId: null,
    artifactId: null,
    author: member.id,
    createdAt: '2026-07-26T00:00:01.000Z'
  }
}

function prepareStore(send: DesignerApi['group']['send']): ReturnType<typeof useCollabStore> {
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      group: { send }
    } as unknown as DesignerApi
  })
  setActivePinia(createPinia())
  const store = useCollabStore()
  store.groups = [group]
  store.roles = [role]
  store.conversationId = group.id
  return store
}

beforeEach(() => {
  localStorage.clear()
})

describe('collab send chain state', () => {
  it.each(['error', 'chain-done'] as const)(
    'IPC 返回前同步收到 %s 后保持非运行态',
    async (type) => {
      const store = prepareStore(vi.fn(async () => undefined))
      window.api.group.send = vi.fn(async () => {
        const event: GroupStreamEvent =
          type === 'error'
            ? { type, conversationId: group.id, message: '启动失败' }
            : { type, conversationId: group.id }
        store.handleEvent(event)
      })

      await store.send('@产品经理 开始')

      expect(store.chainingHere).toBe(false)
    }
  )

  it('IPC 成功且尚未收到终止事件时保持运行态', async () => {
    const store = prepareStore(vi.fn(async () => undefined))

    await store.send('@产品经理 开始')

    expect(store.chainingHere).toBe(true)
  })

  it('IPC 拒绝时回滚预置的运行态', async () => {
    const store = prepareStore(
      vi.fn(async () => {
        throw new Error('发送失败')
      })
    )

    await expect(store.send('@产品经理 开始')).rejects.toThrow('发送失败')

    expect(store.chainingHere).toBe(false)
  })

  it('没有有效成员提及时不进入运行态', async () => {
    const store = prepareStore(vi.fn(async () => undefined))

    await store.send('这只是一条留言')

    expect(store.chainingHere).toBe(false)
  })
})

describe('棒内重试的界面复位', () => {
  it('agent-retry 清掉半截正文与工具流水,留一条重试流水,链路保持运行态', () => {
    const store = prepareStore(vi.fn(async () => undefined))
    store.messages = [assistantMessage('streaming')]
    store.chaining[group.id] = true
    store.activities['message-1'] = [{ callId: 'call-1', label: '读取文件', state: 'executing' }]

    store.handleEvent({
      type: 'agent-retry',
      conversationId: group.id,
      messageId: 'message-1',
      attempt: 2,
      message: '上游在响应中途报错'
    })

    // 半截正文作废,消息回到空白流式态,等下一轮 delta 从头写
    expect(store.messages[0].parts).toEqual([{ type: 'text', text: '' }])
    expect(store.messages[0].status).toBe('streaming')
    expect(store.activities['message-1']).toEqual([
      expect.objectContaining({ state: 'success', summary: '上游在响应中途报错' })
    ])
    expect(store.chainingHere).toBe(true)
  })

  it('后台群收到 agent-retry 只维持运行态,不碰消息', () => {
    const store = prepareStore(vi.fn(async () => undefined))
    store.conversationId = 'other-group'

    store.handleEvent({
      type: 'agent-retry',
      conversationId: group.id,
      messageId: 'message-1',
      attempt: 2,
      message: '上游在响应中途报错'
    })

    expect(store.chaining[group.id]).toBe(true)
    expect(store.messages).toEqual([])
  })
})

describe('collab terminal message state', () => {
  it('意外收到 agent-done 时不把 aborted 消息覆盖成 complete', () => {
    const store = prepareStore(vi.fn(async () => undefined))
    store.messages = [assistantMessage('aborted')]

    store.handleEvent({
      type: 'agent-done',
      conversationId: group.id,
      messageId: 'message-1'
    })

    expect(store.messages[0].status).toBe('aborted')
  })
})
