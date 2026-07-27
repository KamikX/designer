// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type {
  Conversation,
  DesignerApi,
  GroupMember,
  GroupMemberTemplate,
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
  it('IPC 返回前同步收到 chain-done 后保持非运行态', async () => {
    const store = prepareStore(vi.fn(async () => undefined))
    window.api.group.send = vi.fn(async () => {
      store.handleEvent({ type: 'chain-done', conversationId: group.id })
    })

    await store.send('@产品经理 开始')

    expect(store.chainingHere).toBe(false)
  })

  /**
   * 并行接力后 error 是**分支级**的:一条分支挂了别的还在跑,这时解锁输入框
   * 会让用户的下一条被主进程以"上一条还在跑"顶回来。收口只认 chain-done。
   */
  it('error 只记错误不解锁,收到 chain-done 才算结束', async () => {
    const store = prepareStore(vi.fn(async () => undefined))
    window.api.group.send = vi.fn(async () => {
      store.handleEvent({ type: 'error', conversationId: group.id, message: '这条分支挂了' })
    })

    await store.send('@产品经理 开始')
    expect(store.error).toBe('这条分支挂了')
    expect(store.chainingHere).toBe(true)

    store.handleEvent({ type: 'chain-done', conversationId: group.id })
    expect(store.chainingHere).toBe(false)
  })

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

describe('拦停后的一键续棒', () => {
  it('chain-stopped 记下被拦成员,resumeChain 发结构化提及开新链', async () => {
    const sent: string[] = []
    const store = prepareStore(
      vi.fn(async (input: { text: string }) => {
        sent.push(input.text)
      }) as unknown as DesignerApi['group']['send']
    )

    store.handleEvent({
      type: 'chain-stopped',
      conversationId: group.id,
      reason: 'member-limit',
      message: '「产品经理」已参与 3 次',
      nextMemberId: member.id
    })
    expect(store.resumeMember?.name).toBe('产品经理')

    await store.resumeChain()

    // 续棒 = 一条带结构化提及的新用户消息:guard 随新链重置,且留下人为确认的痕迹
    expect(sent[0]).toContain(`@[产品经理](member:${member.id})`)
    expect(sent[0]).toContain('继续')
    expect(store.resumeMemberId).toBe('')
    expect(store.chainingHere).toBe(true)
  })

  it('被拦成员已不在群里时不给续棒入口', () => {
    const store = prepareStore(vi.fn(async () => undefined))

    store.handleEvent({
      type: 'chain-stopped',
      conversationId: group.id,
      reason: 'hop-limit',
      message: '到达上限',
      nextMemberId: '01ARZ3NDEKTSV4RRFFQ69G5FB9'
    })

    expect(store.resumeMember).toBeNull()
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
