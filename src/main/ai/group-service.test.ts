import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  Conversation,
  GroupMember,
  GroupSendInput,
  GroupStreamEvent,
  Message,
  Model,
  WorkspaceRoot
} from '../../shared/types'

const mocks = vi.hoisted(() => ({
  conversation: null as Conversation | null,
  messages: [] as Message[],
  models: new Map<string, Model>(),
  skills: [] as Array<{
    name: string
    description: string
    path: string
    dir: string
    source: 'app' | 'agents' | 'claude' | 'builtin'
  }>,
  outputs: [] as Array<string | Error>,
  streamOptions: [] as Array<Record<string, unknown>>,
  events: [] as GroupStreamEvent[],
  createMessage: vi.fn(),
  updateMessage: vi.fn(),
  getModel: vi.fn(),
  getProviderRowById: vi.fn(),
  getLanguageModel: vi.fn(),
  scanSkills: vi.fn(),
  skillCatalog: vi.fn(),
  skillRoots: vi.fn(),
  buildSkillTools: vi.fn(),
  buildLocalTools: vi.fn(),
  streamText: vi.fn()
}))

vi.mock('electron', () => ({ default: {}, app: {} }))

// openaiCompatOptions 走真实现,只把配置钉死:防止单测碰真实文件系统
vi.mock('../config', () => ({
  readConfig: () => ({ openaiCompat: { store: false, encryptedReasoning: false } })
}))

vi.mock('../db/repo/conversation', () => ({
  getConversation: () => mocks.conversation,
  touchConversation: vi.fn()
}))

vi.mock('../db/repo/message', () => ({
  createMessage: mocks.createMessage,
  listMessages: () => mocks.messages,
  updateMessage: mocks.updateMessage
}))

vi.mock('../db/repo/model', () => ({
  getModel: mocks.getModel
}))

vi.mock('../db/repo/provider', () => ({
  getProviderRowById: mocks.getProviderRowById
}))

vi.mock('./registry', () => ({
  getLanguageModel: mocks.getLanguageModel,
  errorMessage: (error: unknown) => (error instanceof Error ? error.message : String(error))
}))

// 纪要是收棒后的后台增强,不在编排测试的关注面里;钉死避免碰真实 DB
vi.mock('./group-digest', () => ({
  maybeUpdateGroupDigest: vi.fn(async () => undefined)
}))

vi.mock('../db/repo/group-digest', () => ({
  getGroupDigest: () => null,
  saveGroupDigest: vi.fn()
}))

vi.mock('../skills/scan', () => ({
  scanSkills: mocks.scanSkills,
  skillRoots: mocks.skillRoots
}))

vi.mock('../skills/catalog', () => ({
  skillCatalog: mocks.skillCatalog
}))

vi.mock('../skills/tools', () => ({
  buildSkillTools: mocks.buildSkillTools
}))

vi.mock('../workspace/roots', () => ({
  listRoots: () => [
    {
      id: 'root-user',
      conversationId: mocks.conversation?.id,
      name: 'workspace',
      path: '/workspace'
    }
  ]
}))

vi.mock('./local-tools', () => ({
  buildLocalTools: mocks.buildLocalTools
}))

vi.mock('./time-tools', () => ({
  buildTimeTools: () => ({ get_time: { kind: 'time' } })
}))

// 只替换 streamText;APICallError/RetryError 等错误类型保留真实现——
// 棒内重试的瞬时错误判定(ai-errors.ts)要用它们
vi.mock('ai', async (importActual) => ({
  ...(await importActual<typeof import('ai')>()),
  streamText: mocks.streamText
}))

import { abortGroup, sendGroupMessage } from './group-service'

const MEMBER_IDS = [
  '01ARZ3NDEKTSV4RRFFQ69G5FAV',
  '01ARZ3NDEKTSV4RRFFQ69G5FAW',
  '01ARZ3NDEKTSV4RRFFQ69G5FAX',
  '01ARZ3NDEKTSV4RRFFQ69G5FAY',
  '01ARZ3NDEKTSV4RRFFQ69G5FAZ',
  '01ARZ3NDEKTSV4RRFFQ69G5FB0',
  '01ARZ3NDEKTSV4RRFFQ69G5FB1',
  '01ARZ3NDEKTSV4RRFFQ69G5FB2',
  '01ARZ3NDEKTSV4RRFFQ69G5FB3'
]

function model(id: string, providerId = `provider-${id}`, modelId = `vendor-${id}`): Model {
  return {
    id,
    providerId,
    modelId,
    displayName: id,
    type: 'chat',
    abilities: ['tools'],
    contextWindow: 64_000,
    enabled: true,
    isBuiltin: false,
    sortOrder: 0
  }
}

function member(index: number, overrides: Partial<GroupMember> = {}): GroupMember {
  return {
    id: MEMBER_IDS[index],
    name: `成员${index + 1}`,
    color: `#00000${index}`,
    duty: `职责${index + 1}`,
    deliverable: `产出${index + 1}`,
    persona: `人设${index + 1}`,
    modelRowId: `model-${index + 1}`,
    skillIds: [],
    ...overrides
  }
}

function configuredConversation(members: GroupMember[]): Conversation {
  return {
    id: 'group-1',
    projectId: null,
    title: '协作群',
    kind: 'group',
    settings: { members },
    createdAt: '2026-07-26T00:00:00.000Z',
    updatedAt: '2026-07-26T00:00:00.000Z'
  }
}

function input(text: string): GroupSendInput {
  return {
    conversationId: 'group-1',
    text
  }
}

function mention(groupMember: GroupMember): string {
  return `@[${groupMember.name}](member:${groupMember.id})`
}

function sender(): {
  isDestroyed: () => boolean
  send: (channel: string, event: GroupStreamEvent) => void
} {
  return {
    isDestroyed: () => false,
    send: (channel, event) => {
      expect(channel).toBe('group:stream')
      mocks.events.push(event)
    }
  }
}

async function waitForTerminal(): Promise<GroupStreamEvent> {
  await vi.waitFor(() => {
    expect(
      mocks.events.some(
        (event) =>
          event.type === 'chain-done' || event.type === 'chain-stopped' || event.type === 'error'
      )
    ).toBe(true)
  })
  return mocks.events.findLast(
    (event) =>
      event.type === 'chain-done' || event.type === 'chain-stopped' || event.type === 'error'
  )!
}

afterEach(() => {
  vi.useRealTimers()
})

beforeEach(() => {
  mocks.conversation = null
  mocks.messages.length = 0
  mocks.models.clear()
  mocks.skills.length = 0
  mocks.outputs.length = 0
  mocks.streamOptions.length = 0
  mocks.events.length = 0
  vi.clearAllMocks()

  mocks.createMessage.mockImplementation(
    (
      draft: Omit<Message, 'id' | 'createdAt' | 'usage' | 'providerSlug' | 'artifactId'> & {
        providerSlug?: string
      }
    ) => {
      const created: Message = {
        ...draft,
        id: `message-${mocks.messages.length + 1}`,
        status: draft.status ?? 'complete',
        usage: null,
        providerSlug: draft.providerSlug ?? null,
        modelId: draft.modelId ?? null,
        artifactId: null,
        createdAt: `2026-07-26T00:00:0${mocks.messages.length}.000Z`
      }
      mocks.messages.push(created)
      return created
    }
  )
  mocks.updateMessage.mockImplementation((id: string, patch: Partial<Message>) => {
    const stored = mocks.messages.find((message) => message.id === id)
    if (stored) Object.assign(stored, patch)
    return stored ?? null
  })
  mocks.getModel.mockImplementation((id: string) => mocks.models.get(id) ?? null)
  mocks.getProviderRowById.mockImplementation((id: string) => ({
    id,
    slug: `slug-${id}`
  }))
  mocks.getLanguageModel.mockImplementation(
    (providerId: string, modelId: string) => `language:${providerId}/${modelId}`
  )
  mocks.scanSkills.mockImplementation(() => mocks.skills)
  mocks.skillCatalog.mockImplementation(
    (skills: typeof mocks.skills) => `CATALOG:${skills.map((skill) => skill.name).join(',')}`
  )
  mocks.skillRoots.mockImplementation((skills: typeof mocks.skills): WorkspaceRoot[] =>
    skills.map((skill) => ({
      id: `skill-root-${skill.name}`,
      conversationId: 'group-1',
      name: `skill:${skill.name}`,
      path: skill.dir
    }))
  )
  mocks.buildSkillTools.mockImplementation((skills: typeof mocks.skills) =>
    skills.length > 0 ? { activate_skill: { selected: skills.map((skill) => skill.name) } } : {}
  )
  mocks.buildLocalTools.mockImplementation((roots: WorkspaceRoot[]) => ({
    read_local_file: { roots: roots.map((root) => root.name) }
  }))
  mocks.streamText.mockImplementation((options: Record<string, unknown>) => {
    mocks.streamOptions.push(options)
    const output = mocks.outputs.shift() ?? '@用户 完成'
    return {
      fullStream: (async function* () {
        if (output instanceof Error) {
          yield { type: 'error', error: output }
          return
        }
        yield { type: 'text-delta', text: output }
      })()
    }
  })
})

describe('configured 群组成员级编排', () => {
  it('按成员隔离模型、技能、system、roots，并用结构化提及路由', async () => {
    const first = member(0, {
      name: '研究员',
      modelRowId: 'model-research',
      skillIds: ['research', 'builtin-craft']
    })
    const second = member(1, {
      name: '写作者',
      modelRowId: 'model-writing',
      skillIds: ['writing', 'missing']
    })
    mocks.conversation = configuredConversation([first, second])
    mocks.models.set('model-research', model('model-research', 'provider-a', 'shared-chat'))
    mocks.models.set('model-writing', model('model-writing', 'provider-b', 'shared-chat'))
    mocks.skills.push(
      {
        name: 'research',
        description: 'research',
        path: '/skills/research/SKILL.md',
        dir: '/skills/research',
        source: 'app'
      },
      {
        name: 'writing',
        description: 'writing',
        path: '/skills/writing/SKILL.md',
        dir: '/skills/writing',
        source: 'agents'
      },
      {
        name: 'builtin-craft',
        description: 'builtin',
        path: '/skills/builtin/SKILL.md',
        dir: '/skills/builtin',
        source: 'builtin'
      }
    )
    mocks.outputs.push(`${mention(second)} 请接棒`, '@用户 完成')

    sendGroupMessage(sender() as never, input(`${mention(first)} 请开始`))
    expect((await waitForTerminal()).type).toBe('chain-done')

    expect(mocks.getLanguageModel.mock.calls).toEqual([
      ['provider-a', 'shared-chat'],
      ['provider-b', 'shared-chat']
    ])
    expect(mocks.streamOptions.map((options) => options.model)).toEqual([
      'language:provider-a/shared-chat',
      'language:provider-b/shared-chat'
    ])
    // OpenAI 兼容参数必须每一棒都带:漏掉会在不持久化的中转站上复发
    // "Item with id 'rs_...' not found"(多步工具调用回传 reasoning 条目 id)
    for (const options of mocks.streamOptions) {
      expect(options.providerOptions).toEqual({ openai: { store: false } })
    }
    // builtin 设计技能在群组里不自动启用,但被显式勾选后必须生效
    expect(
      mocks.skillCatalog.mock.calls.map(([skills]) => skills.map((skill) => skill.name))
    ).toEqual([['research', 'builtin-craft'], ['writing']])
    expect(mocks.streamOptions[0].system).toContain('CATALOG:research')
    expect(mocks.streamOptions[0].system).not.toContain('CATALOG:writing')
    expect(mocks.streamOptions[1].system).toContain('CATALOG:writing')
    expect(mocks.streamOptions[1].system).not.toContain('CATALOG:research')
    expect(mocks.streamOptions[0].system).toContain('@研究员(职责1)')
    expect(mocks.streamOptions[0].system).toContain('@写作者(职责2)')
    expect(
      mocks.buildLocalTools.mock.calls.map(([roots]) => roots.map((root) => root.name))
    ).toEqual([
      ['workspace', 'skill:research', 'skill:builtin-craft'],
      ['workspace', 'skill:writing']
    ])
    expect(mocks.streamOptions[0].tools).toMatchObject({
      get_time: { kind: 'time' },
      activate_skill: { selected: ['research', 'builtin-craft'] },
      read_local_file: { roots: ['workspace', 'skill:research', 'skill:builtin-craft'] }
    })
    expect(mocks.streamOptions[1].tools).toMatchObject({
      activate_skill: { selected: ['writing'] },
      read_local_file: { roots: ['workspace', 'skill:writing'] }
    })
    expect(mocks.streamOptions[0].messages).toEqual([
      {
        role: 'user',
        content: expect.stringContaining('@研究员 请开始')
      }
    ])
    expect(JSON.stringify(mocks.streamOptions[0].messages)).not.toContain('(member:')
    expect(mocks.streamOptions[1].messages).toEqual([
      {
        role: 'user',
        content: expect.stringMatching(/【研究员】[\s\S]*@写作者 请接棒/)
      }
    ])
    expect(JSON.stringify(mocks.streamOptions[1].messages)).not.toContain('(member:')

    const assistantCreates = mocks.createMessage.mock.calls
      .map(([draft]) => draft)
      .filter((draft) => draft.role === 'assistant')
    expect(mocks.scanSkills).toHaveBeenCalledTimes(1)
    expect(assistantCreates).toMatchObject([
      {
        author: first.id,
        providerSlug: 'slug-provider-a',
        modelId: 'shared-chat'
      },
      {
        author: second.id,
        providerSlug: 'slug-provider-b',
        modelId: 'shared-chat'
      }
    ])
  })

  it('只解析成员自己的模型', async () => {
    const configured = member(0, { modelRowId: 'member-model' })
    mocks.conversation = configuredConversation([configured])
    mocks.models.set('member-model', model('member-model'))
    mocks.outputs.push('@用户 完成')

    sendGroupMessage(sender() as never, input(`${mention(configured)} 开始`))
    expect((await waitForTerminal()).type).toBe('chain-done')

    expect(mocks.getModel).toHaveBeenCalledWith('member-model')
  })
})

describe('不可信成员设置', () => {
  it.each([
    ['members 缺失', {}],
    ['旧 string[]', { members: ['pm'] }],
    ['字段不完整的对象数组', { members: [{ id: MEMBER_IDS[0], name: '产品经理' }] }]
  ])('%s时仍保存用户留言，但不生成成员或启动 agent', async (_label, settings) => {
    mocks.conversation = {
      ...configuredConversation([]),
      settings
    } as unknown as Conversation

    sendGroupMessage(sender() as never, input('@产品经理 请开始'))
    expect(await waitForTerminal()).toMatchObject({ type: 'chain-done' })

    expect(mocks.messages).toEqual([
      expect.objectContaining({
        role: 'user',
        author: 'user',
        parts: [{ type: 'text', text: '@产品经理 请开始' }]
      })
    ])
    expect(mocks.scanSkills).not.toHaveBeenCalled()
    expect(mocks.streamText).not.toHaveBeenCalled()
  })
})

describe('成员解析错误', () => {
  it('成员模型的供应商不存在时标错当前成员并报告成员名称', async () => {
    const configured = member(0, { name: '研究员', modelRowId: 'orphan-model' })
    mocks.conversation = configuredConversation([configured])
    mocks.models.set('orphan-model', model('orphan-model', 'missing-provider', 'orphan-chat'))
    mocks.getProviderRowById.mockReturnValueOnce(null)

    sendGroupMessage(sender() as never, input(mention(configured)))
    await vi.waitFor(() => {
      expect(mocks.events.some((event) => event.type === 'error')).toBe(true)
    })

    expect(mocks.events.find((event) => event.type === 'error')).toMatchObject({
      type: 'error',
      message: expect.stringMatching(/研究员.*供应商.*不存在/)
    })
    expect(mocks.messages.find((message) => message.author === configured.id)).toMatchObject({
      status: 'error',
      providerSlug: null,
      modelId: 'orphan-chat'
    })
  })
})

describe('链路停止与清理', () => {
  it('中止后持久化 aborted，且只发 chain-done 不发 agent-done', async () => {
    const configured = member(0)
    mocks.conversation = configuredConversation([configured])
    mocks.models.set(configured.modelRowId, model(configured.modelRowId))
    mocks.streamText.mockImplementationOnce((options: Record<string, unknown>) => {
      mocks.streamOptions.push(options)
      return {
        fullStream: (async function* () {
          yield { type: 'text-delta', text: '部分内容' }
          abortGroup('group-1')
          yield { type: 'abort' }
        })()
      }
    })

    sendGroupMessage(sender() as never, input(mention(configured)))
    expect((await waitForTerminal()).type).toBe('chain-done')

    expect(mocks.updateMessage).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ status: 'aborted' })
    )
    expect(mocks.events.some((event) => event.type === 'agent-done')).toBe(false)
  })

  it('技能扫描失败时报告链级错误、正常收链并清理 running', async () => {
    const configured = member(0)
    mocks.conversation = configuredConversation([configured])
    mocks.models.set(configured.modelRowId, model(configured.modelRowId))
    mocks.scanSkills.mockImplementationOnce(() => {
      throw new Error('技能目录损坏')
    })
    mocks.outputs.push('@用户 完成')

    sendGroupMessage(sender() as never, input(mention(configured)))
    await vi.waitFor(() => {
      expect(mocks.events.some((event) => event.type === 'error')).toBe(true)
    })
    expect(mocks.events.find((event) => event.type === 'error')).toEqual({
      conversationId: 'group-1',
      type: 'error',
      message: '技能目录损坏'
    })
    expect((await waitForTerminal()).type).toBe('chain-done')
    await Promise.resolve()

    mocks.events.length = 0
    expect(() => sendGroupMessage(sender() as never, input(mention(configured)))).not.toThrow()
    expect((await waitForTerminal()).type).toBe('chain-done')
  })

  it('重复有向边发 cycle-detected，不再执行被拒绝的一棒', async () => {
    const [a, b] = [member(0), member(1)]
    mocks.conversation = configuredConversation([a, b])
    mocks.models.set(a.modelRowId, model(a.modelRowId))
    mocks.models.set(b.modelRowId, model(b.modelRowId))
    mocks.outputs.push(mention(b), mention(a), mention(b))

    sendGroupMessage(sender() as never, input(mention(a)))
    expect(await waitForTerminal()).toMatchObject({
      type: 'chain-stopped',
      reason: 'cycle-detected',
      // 拦停文案用成员名并告诉用户可以手动 @ 继续
      message: expect.stringContaining('「成员1 → 成员2」')
    })
    expect(mocks.streamOptions).toHaveLength(3)
    expect(mocks.events.some((event) => event.type === 'chain-done')).toBe(false)
  })

  it('成员第三次参与发 member-limit', async () => {
    const [a, b, c] = [member(0), member(1), member(2)]
    mocks.conversation = configuredConversation([a, b, c])
    for (const item of [a, b, c]) mocks.models.set(item.modelRowId, model(item.modelRowId))
    mocks.outputs.push(mention(b), mention(a), mention(c), mention(a))

    sendGroupMessage(sender() as never, input(mention(a)))
    expect(await waitForTerminal()).toMatchObject({
      type: 'chain-stopped',
      reason: 'member-limit'
    })
    expect(mocks.streamOptions).toHaveLength(4)
  })

  it('第九位成员开始前发 hop-limit，不被 for 循环静默截断', async () => {
    const members = MEMBER_IDS.map((_id, index) => member(index))
    mocks.conversation = configuredConversation(members)
    for (const item of members) mocks.models.set(item.modelRowId, model(item.modelRowId))
    mocks.outputs.push(...members.slice(1).map(mention))

    sendGroupMessage(sender() as never, input(mention(members[0])))
    expect(await waitForTerminal()).toMatchObject({
      type: 'chain-stopped',
      reason: 'hop-limit',
      message: expect.stringContaining('8')
    })
    expect(mocks.streamOptions).toHaveLength(8)
  })

  it('运行异常后清理 running，允许同一群再次发送', async () => {
    const configured = member(0)
    mocks.conversation = configuredConversation([configured])
    mocks.models.set(configured.modelRowId, model(configured.modelRowId))
    mocks.outputs.push(new Error('上游失败'))

    sendGroupMessage(sender() as never, input(mention(configured)))
    await vi.waitFor(() => {
      expect(mocks.events.some((event) => event.type === 'error')).toBe(true)
    })
    expect(mocks.events.find((event) => event.type === 'error')).toMatchObject({
      type: 'error',
      message: '上游失败'
    })
    expect((await waitForTerminal()).type).toBe('chain-done')
    await Promise.resolve()

    mocks.events.length = 0
    mocks.outputs.push('@用户 完成')
    expect(() => sendGroupMessage(sender() as never, input(mention(configured)))).not.toThrow()
    expect((await waitForTerminal()).type).toBe('chain-done')
  })
})

describe('瞬时上游故障的棒内重试', () => {
  /** 真实案例:中转站读上游失败,HTTP 已 200,错误以 SSE 事件形式回流 */
  const STREAM_ERROR = {
    type: 'error',
    sequence_number: 0,
    error: { type: 'upstream_error', code: 'stream_read_error', message: 'stream_read_error' }
  }

  function failingStream(options: Record<string, unknown>): { fullStream: AsyncGenerator } {
    mocks.streamOptions.push(options)
    return {
      fullStream: (async function* () {
        yield { type: 'text-delta', text: '写了一半的' }
        yield { type: 'error', error: STREAM_ERROR }
      })()
    }
  }

  /** 退避用 setTimeout,假时钟下要边推进边等终态 */
  async function advanceUntilTerminal(): Promise<void> {
    for (let round = 0; round < 40; round++) {
      await vi.advanceTimersByTimeAsync(500)
      const done = mocks.events.some(
        (event) =>
          event.type === 'chain-done' || event.type === 'chain-stopped' || event.type === 'error'
      )
      if (done) {
        // 终态事件后链路还有收尾(chain-done 等),再放一轮微任务
        await vi.advanceTimersByTimeAsync(0)
        return
      }
    }
    throw new Error('链路没有在预期时间内结束')
  }

  it('流中途 upstream_error 自动重试当前棒,成功后不打断链路', async () => {
    vi.useFakeTimers()
    const configured = member(0)
    mocks.conversation = configuredConversation([configured])
    mocks.models.set(configured.modelRowId, model(configured.modelRowId))
    mocks.streamText.mockImplementationOnce(failingStream)
    mocks.outputs.push('@用户 完成')

    sendGroupMessage(sender() as never, input(mention(configured)))
    await advanceUntilTerminal()

    expect(mocks.streamText).toHaveBeenCalledTimes(2)
    // 重试沿用同一条消息:agent-start 只发一次,靠 agent-retry 通知清半截正文
    expect(mocks.events.filter((event) => event.type === 'agent-start')).toHaveLength(1)
    expect(mocks.events.find((event) => event.type === 'agent-retry')).toMatchObject({
      attempt: 2,
      messageId: expect.any(String)
    })
    expect(mocks.events.some((event) => event.type === 'error')).toBe(false)
    expect(mocks.events.some((event) => event.type === 'chain-done')).toBe(true)
    expect(mocks.messages.find((m) => m.role === 'assistant')).toMatchObject({
      status: 'complete',
      parts: [{ type: 'text', text: '@用户 完成' }]
    })
  })

  it('连续三次瞬时失败后放弃:标错这一棒并停链,半截正文照旧持久化', async () => {
    vi.useFakeTimers()
    const configured = member(0)
    mocks.conversation = configuredConversation([configured])
    mocks.models.set(configured.modelRowId, model(configured.modelRowId))
    mocks.streamText.mockImplementation(failingStream)

    sendGroupMessage(sender() as never, input(mention(configured)))
    await advanceUntilTerminal()

    expect(mocks.streamText).toHaveBeenCalledTimes(3)
    expect(
      mocks.events.flatMap((event) => (event.type === 'agent-retry' ? [event.attempt] : []))
    ).toEqual([2, 3])
    expect(mocks.events.some((event) => event.type === 'error')).toBe(true)
    expect(mocks.events.some((event) => event.type === 'chain-done')).toBe(true)
    expect(mocks.messages.find((m) => m.role === 'assistant')).toMatchObject({
      status: 'error',
      parts: [{ type: 'text', text: '写了一半的' }]
    })
  })

  it('非瞬时错误(配置类)不重试:一次失败立刻标错', async () => {
    const configured = member(0)
    mocks.conversation = configuredConversation([configured])
    mocks.models.set(configured.modelRowId, model(configured.modelRowId))
    mocks.outputs.push(new Error('供应商「x」缺少 Base URL'))

    sendGroupMessage(sender() as never, input(mention(configured)))
    await waitForTerminal()

    expect(mocks.streamText).toHaveBeenCalledTimes(1)
    expect(mocks.events.some((event) => event.type === 'agent-retry')).toBe(false)
    expect(mocks.events.some((event) => event.type === 'error')).toBe(true)
  })
})
