import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { Message } from '../../shared/types'

/**
 * 前情纪要更新的行为契约:
 * - 没触发折叠就不花模型调用;
 * - 覆盖水位与 transcript 折叠边界一致,水位不前进就跳过;
 * - 生成失败静默(下一棒退回机械折叠),绝不向接力链抛错。
 */

const mocks = vi.hoisted(() => ({
  messages: [] as Message[],
  digest: null as { text: string; coveredUntilId: string } | null,
  assistant: null as { providerId: string; modelId: string; label: string } | null,
  saveGroupDigest: vi.fn(),
  generateText: vi.fn(),
  getLanguageModel: vi.fn(() => 'language-model')
}))

vi.mock('../db/repo/message', () => ({
  listMessages: () => mocks.messages
}))

vi.mock('../db/repo/group-digest', () => ({
  getGroupDigest: () => mocks.digest,
  saveGroupDigest: mocks.saveGroupDigest
}))

vi.mock('../db/repo/provider', () => ({
  getProviderRowById: (id: string) => ({ id, slug: `slug-${id}`, adapter: 'openai' })
}))

vi.mock('./registry', () => ({
  getLanguageModel: mocks.getLanguageModel
}))

vi.mock('./assistant', () => ({
  resolveAssistantModel: () => mocks.assistant
}))

vi.mock('./provider-options', () => ({
  openaiCompatOptions: () => ({ store: false })
}))

// 观测收口在 run-trace 自己的实现里,这里只要求"计费调用都有 trace 包裹"
vi.mock('./run-trace', () => ({
  RunTraceCollector: class {
    start = vi.fn()
    finish = vi.fn()
    modelCallStart = vi.fn()
    stepEnd = vi.fn()
  }
}))

vi.mock('ai', async (importActual) => ({
  ...(await importActual<typeof import('ai')>()),
  generateText: mocks.generateText
}))

import { maybeUpdateGroupDigest } from './group-digest'

const PM = { id: '01ARZ3NDEKTSV4RRFFQ69G5FAV', name: '产品经理' }
const ARCH = { id: '01ARZ3NDEKTSV4RRFFQ69G5FAW', name: '架构师' }
const MEMBERS = [PM, ARCH]

let seq = 0
function message(author: string, text: string): Message {
  seq++
  return {
    id: `msg-${String(seq).padStart(3, '0')}`,
    conversationId: 'group-1',
    role: author === 'user' ? 'user' : 'assistant',
    parts: [{ type: 'text', text }],
    status: 'complete',
    usage: null,
    providerSlug: null,
    modelId: null,
    artifactId: null,
    author,
    createdAt: `2026-07-26T00:00:${String(seq).padStart(2, '0')}.000Z`
  }
}

function doc(title: string, chars: number): string {
  return `# ${title}\n${'正'.repeat(chars)}\n@架构师 接棒`
}

// contextWindow=1000 → 预算取下限 24000 字符
const INPUT = {
  conversationId: 'group-1',
  members: MEMBERS,
  providerId: 'provider-1',
  modelId: 'vendor-model',
  contextWindow: 1000
}

beforeEach(() => {
  mocks.messages = []
  mocks.digest = null
  mocks.assistant = null
  mocks.saveGroupDigest.mockReset()
  mocks.generateText.mockReset()
  mocks.getLanguageModel.mockClear()
  mocks.generateText.mockResolvedValue({ text: '纪要正文' })
})

describe('maybeUpdateGroupDigest', () => {
  it('未触发折叠时不调用模型', async () => {
    mocks.messages = [message('user', '短对话'), message(PM.id, '短回复')]

    await maybeUpdateGroupDigest(INPUT)

    expect(mocks.generateText).not.toHaveBeenCalled()
    expect(mocks.saveGroupDigest).not.toHaveBeenCalled()
  })

  it('触发折叠时生成并保存,覆盖水位=折叠边界最后一条', async () => {
    mocks.messages = [
      message('user', '开始'),
      message(PM.id, doc('需求v1', 10_000)),
      message(ARCH.id, doc('架构一稿', 10_000)),
      message(PM.id, doc('需求修订', 10_000)),
      message(ARCH.id, doc('架构二稿', 10_000))
    ]

    await maybeUpdateGroupDigest(INPUT)

    // 折叠的是需求v1与架构一稿,水位应停在后者
    expect(mocks.saveGroupDigest).toHaveBeenCalledWith('group-1', {
      text: '纪要正文',
      coveredUntilId: mocks.messages[2].id
    })
    const prompt = (mocks.generateText.mock.calls[0][0] as { prompt: string }).prompt
    expect(prompt).toContain('【用户】')
    expect(prompt).toContain('# 需求v1')
    expect(prompt).toContain('# 架构一稿')
    // 水位之后的发言不进纪要输入
    expect(prompt).not.toContain('# 需求修订')
  })

  it('已有纪要时增量更新:旧纪要进 prompt,只喂新覆盖的发言', async () => {
    mocks.messages = [
      message('user', '开始'),
      message(PM.id, doc('需求v1', 10_000)),
      message(ARCH.id, doc('架构一稿', 10_000)),
      message(PM.id, doc('需求修订', 10_000)),
      message(ARCH.id, doc('架构二稿', 10_000))
    ]
    mocks.digest = { text: '旧纪要', coveredUntilId: mocks.messages[1].id }

    await maybeUpdateGroupDigest(INPUT)

    const prompt = (mocks.generateText.mock.calls[0][0] as { prompt: string }).prompt
    expect(prompt).toContain('已有纪要')
    expect(prompt).toContain('旧纪要')
    expect(prompt).not.toContain('# 需求v1')
    expect(prompt).toContain('# 架构一稿')
  })

  it('覆盖水位没前进时跳过,不重复计费', async () => {
    mocks.messages = [
      message('user', '开始'),
      message(PM.id, doc('需求v1', 10_000)),
      message(ARCH.id, doc('架构一稿', 10_000)),
      message(PM.id, doc('需求修订', 10_000)),
      message(ARCH.id, doc('架构二稿', 10_000))
    ]
    mocks.digest = { text: '旧纪要', coveredUntilId: mocks.messages[2].id }

    await maybeUpdateGroupDigest(INPUT)

    expect(mocks.generateText).not.toHaveBeenCalled()
  })

  it('配了全局辅助模型就用它(便宜模型做压缩),没配才用收棒成员的模型', async () => {
    mocks.messages = [
      message('user', '开始'),
      message(PM.id, doc('需求v1', 10_000)),
      message(ARCH.id, doc('架构一稿', 10_000)),
      message(PM.id, doc('需求修订', 10_000)),
      message(ARCH.id, doc('架构二稿', 10_000))
    ]
    mocks.assistant = { providerId: 'cheap-provider', modelId: 'cheap-model', label: '小模型' }

    await maybeUpdateGroupDigest(INPUT)

    expect(mocks.getLanguageModel).toHaveBeenCalledWith('cheap-provider', 'cheap-model')
    expect(mocks.getLanguageModel).not.toHaveBeenCalledWith('provider-1', 'vendor-model')
  })

  it('没配辅助模型时退回收棒成员自己的模型', async () => {
    mocks.messages = [
      message('user', '开始'),
      message(PM.id, doc('需求v1', 10_000)),
      message(ARCH.id, doc('架构一稿', 10_000)),
      message(PM.id, doc('需求修订', 10_000)),
      message(ARCH.id, doc('架构二稿', 10_000))
    ]

    await maybeUpdateGroupDigest(INPUT)

    expect(mocks.getLanguageModel).toHaveBeenCalledWith('provider-1', 'vendor-model')
  })

  it('生成失败静默,不保存也不抛', async () => {
    mocks.messages = [
      message('user', '开始'),
      message(PM.id, doc('需求v1', 10_000)),
      message(ARCH.id, doc('架构一稿', 10_000)),
      message(PM.id, doc('需求修订', 10_000)),
      message(ARCH.id, doc('架构二稿', 10_000))
    ]
    mocks.generateText.mockRejectedValue(new Error('上游超时'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await expect(maybeUpdateGroupDigest(INPUT)).resolves.toBeUndefined()

    expect(mocks.saveGroupDigest).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})
