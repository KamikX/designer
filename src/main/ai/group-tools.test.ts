import { describe, expect, it, vi } from 'vitest'
import type { Message } from '../../shared/types'

/**
 * 群聊历史回读工具的行为契约:折叠存根里的消息 id 必须能换回原文,
 * 且模型给的 id 一律当不可信输入(只认本群组、拒绝越界行号)。
 */

const mocks = vi.hoisted(() => ({
  messages: [] as Message[]
}))

vi.mock('../db/repo/message', () => ({
  listMessages: (conversationId: string) =>
    mocks.messages.filter((message) => message.conversationId === conversationId)
}))

import { buildGroupHistoryTools } from './group-tools'

const PM = { id: '01ARZ3NDEKTSV4RRFFQ69G5FAV', name: '产品经理' }

let seq = 0
function message(
  conversationId: string,
  author: string,
  text: string,
  status: Message['status'] = 'complete'
): Message {
  seq++
  return {
    id: `msg-${String(seq).padStart(3, '0')}`,
    conversationId,
    role: author === 'user' ? 'user' : 'assistant',
    parts: [{ type: 'text', text }],
    status,
    usage: null,
    providerSlug: null,
    modelId: null,
    artifactId: null,
    author,
    createdAt: `2026-07-26T00:00:${String(seq).padStart(2, '0')}.000Z`
  }
}

type Executable = { execute: (input: Record<string, unknown>) => Promise<string> }

function tools(): { list: Executable; read: Executable } {
  const set = buildGroupHistoryTools('group-1', [PM])
  return {
    list: set.list_group_messages as unknown as Executable,
    read: set.read_group_message as unknown as Executable
  }
}

describe('list_group_messages', () => {
  it('列出 id / 发言人 / 字数 / 首行标题,排除流式中的半条', async () => {
    mocks.messages = [
      message('group-1', 'user', '开始干活'),
      message('group-1', PM.id, '# 需求文档\n正文若干'),
      message('group-1', PM.id, '写了一半的', 'streaming'),
      message('group-2', PM.id, '别的群的消息')
    ]

    const out = await tools().list.execute({})

    expect(out).toContain('用户 | 4 字 | 开始干活')
    expect(out).toContain('产品经理')
    expect(out).toContain('# 需求文档')
    expect(out).not.toContain('写了一半的')
    expect(out).not.toContain('别的群的消息')
  })
})

describe('read_group_message', () => {
  it('按 id 读回全文', async () => {
    const doc = message('group-1', PM.id, '# 需求\n第一行\n第二行')
    mocks.messages = [doc]

    const out = await tools().read.execute({ message_id: doc.id })

    expect(out).toContain('# 需求')
    expect(out).toContain('第二行')
  })

  it('按行区间读,并注明总行数与当前区间', async () => {
    const doc = message('group-1', PM.id, ['# 标题', ...Array(30).fill('内容行')].join('\n'))
    mocks.messages = [doc]

    const out = await tools().read.execute({ message_id: doc.id, start_line: 2, end_line: 4 })

    expect(out).not.toContain('# 标题')
    expect(out).toContain('共 31 行,当前看的是 2-4')
  })

  it('不认识的 id 与越界行号给人话错误,不抛', async () => {
    const foreign = message('group-2', PM.id, '别的群的文档')
    const own = message('group-1', PM.id, '只有一行')
    mocks.messages = [foreign, own]

    // 别的群的消息 id 等同不存在:防串群读取
    expect(await tools().read.execute({ message_id: foreign.id })).toContain('没有 id 为')
    expect(await tools().read.execute({ message_id: own.id, start_line: 99 })).toContain('越界')
  })

  it('超长内容截断并提示缩小区间', async () => {
    const doc = message('group-1', PM.id, '长'.repeat(13_000))
    mocks.messages = [doc]

    const out = await tools().read.execute({ message_id: doc.id })

    expect(out).toContain('已截断')
    expect(out.length).toBeLessThan(12_200)
  })
})
