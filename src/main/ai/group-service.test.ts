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
  /**
   * 按成员模型取输出。并行 fan-out 之后 outputs 那条 FIFO 不再可靠——
   * 谁先跑到 streamText 是不确定的,拿错输出会让用例随机失败。
   */
  outputsByModel: new Map<string, Array<string | Error>>(),
  /** 挡住所有棒的出栈,用来观察"此刻有几棒同时在跑" */
  hold: null as Promise<void> | null,
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

/**
 * 等到本轮真正结束。
 *
 * 接力是树之后 chain-done 是**唯一**的"全部分支跑完"信号:某条分支被 guard
 * 拦停或报错都只是分支级事件,后面还会有别的分支在跑。所以终点只认 chain-done,
 * 分支级的 chain-stopped / error 用 stoppedEvent / errorEvent 单独断言。
 */
async function waitForTerminal(): Promise<GroupStreamEvent> {
  await vi.waitFor(() => {
    expect(mocks.events.some((event) => event.type === 'chain-done')).toBe(true)
  })
  return mocks.events.findLast((event) => event.type === 'chain-done')!
}

/** 本轮出现过的分支拦停事件(取第一条) */
function stoppedEvent(): Extract<GroupStreamEvent, { type: 'chain-stopped' }> | undefined {
  return mocks.events.find(
    (event): event is Extract<GroupStreamEvent, { type: 'chain-stopped' }> =>
      event.type === 'chain-stopped'
  )
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
  mocks.outputsByModel.clear()
  mocks.hold = null
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
    const keyed = mocks.outputsByModel.get(String(options.model))
    const output = (keyed?.length ? keyed.shift() : mocks.outputs.shift()) ?? '@用户 完成'
    const hold = mocks.hold
    return {
      fullStream: (async function* () {
        // 卡在这里时这一棒是"进行中"的:用例可以断言同时有几棒在跑
        if (hold) await hold
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

  it('同边第三次发 cycle-detected,允许前两次(完整评审返工),并带可续棒成员', async () => {
    const [a, b] = [member(0), member(1)]
    mocks.conversation = configuredConversation([a, b])
    mocks.models.set(a.modelRowId, model(a.modelRowId))
    mocks.models.set(b.modelRowId, model(b.modelRowId))
    mocks.outputs.push(mention(b), mention(a), mention(b), mention(a), mention(b))

    sendGroupMessage(sender() as never, input(mention(a)))
    await waitForTerminal()
    expect(stoppedEvent()).toMatchObject({
      type: 'chain-stopped',
      reason: 'cycle-detected',
      // 拦停文案用成员名并告诉用户可以手动 @ 继续
      message: expect.stringContaining('「成员1 → 成员2」'),
      // 一键续棒靠它定位被拦的成员
      nextMemberId: b.id
    })
    expect(mocks.streamOptions).toHaveLength(5)
    // 拦停之后仍然要收口:chain-done 是渲染层唯一的"可以再发言了"信号
    expect(mocks.events.filter((event) => event.type === 'chain-done')).toHaveLength(1)
  })

  it('成员第四次参与发 member-limit,第三次(复审)放行', async () => {
    const [a, b, c] = [member(0), member(1), member(2)]
    mocks.conversation = configuredConversation([a, b, c])
    for (const item of [a, b, c]) mocks.models.set(item.modelRowId, model(item.modelRowId))
    mocks.outputs.push(mention(b), mention(a), mention(c), mention(a), mention(b), mention(a))

    sendGroupMessage(sender() as never, input(mention(a)))
    await waitForTerminal()
    expect(stoppedEvent()).toMatchObject({
      type: 'chain-stopped',
      reason: 'member-limit',
      nextMemberId: a.id
    })
    expect(mocks.streamOptions).toHaveLength(6)
  })

  it('第九位成员开始前发 hop-limit，不被 for 循环静默截断', async () => {
    const members = MEMBER_IDS.map((_id, index) => member(index))
    mocks.conversation = configuredConversation(members)
    for (const item of members) mocks.models.set(item.modelRowId, model(item.modelRowId))
    mocks.outputs.push(...members.slice(1).map(mention))

    sendGroupMessage(sender() as never, input(mention(members[0])))
    await waitForTerminal()
    expect(stoppedEvent()).toMatchObject({
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

/**
 * 一条消息 @ 多位时的并行 fan-out。
 *
 * 以前只有第一个被 @ 的人会回复,后面点名的直接被丢掉——用户得再发一条。
 * 现在接力是树:被点名的每个人各起一条分支同时开跑,每棒 @ 的人再分叉。
 */
describe('多 @ 并行 fan-out', () => {
  function deferred(): { promise: Promise<void>; resolve: () => void } {
    let resolve!: () => void
    const promise = new Promise<void>((r) => (resolve = r))
    return { promise, resolve }
  }

  /** 用 modelRowId 定位一棒的输出:并行下 FIFO 会拿错 */
  function outputFor(target: GroupMember, ...values: Array<string | Error>): void {
    mocks.outputsByModel.set(`language:provider-${target.modelRowId}/vendor-${target.modelRowId}`, [
      ...values
    ])
  }

  function transcriptOf(index: number): string {
    const messages = mocks.streamOptions[index].messages as Array<{ content: string }>
    return messages[0].content
  }

  it('两位被点名的成员同时开跑,各自落一条消息', async () => {
    const [a, b] = [member(0), member(1)]
    mocks.conversation = configuredConversation([a, b])
    for (const item of [a, b]) mocks.models.set(item.modelRowId, model(item.modelRowId))
    outputFor(a, '@用户 schema 改好了')
    outputFor(b, '@用户 评审通过')

    const gate = deferred()
    mocks.hold = gate.promise

    sendGroupMessage(sender() as never, input(`${mention(a)} 改 schema。${mention(b)} 验证方案`))

    // 卡住两棒的输出:此刻两条消息都该在流式中,这就是"同时跑"
    await vi.waitFor(() => expect(mocks.streamOptions).toHaveLength(2))
    expect(mocks.messages.filter((m) => m.status === 'streaming')).toHaveLength(2)

    gate.resolve()
    mocks.hold = null
    await waitForTerminal()

    const authors = mocks.messages.filter((m) => m.role === 'assistant').map((m) => m.author)
    expect(new Set(authors)).toEqual(new Set([a.id, b.id]))
    expect(mocks.events.filter((event) => event.type === 'chain-done')).toHaveLength(1)
  })

  it('每人只拿到点名给自己的那句交代,不是整条消息', async () => {
    const [a, b] = [member(0), member(1)]
    mocks.conversation = configuredConversation([a, b])
    for (const item of [a, b]) mocks.models.set(item.modelRowId, model(item.modelRowId))
    outputFor(a, '@用户 完成')
    outputFor(b, '@用户 完成')

    sendGroupMessage(sender() as never, input(`${mention(a)} 改 schema。${mention(b)} 验证方案`))
    await waitForTerminal()

    const byModel = new Map(
      mocks.streamOptions.map((options, index) => [String(options.model), transcriptOf(index)])
    )
    const forA = byModel.get(`language:provider-${a.modelRowId}/vendor-${a.modelRowId}`)!
    const forB = byModel.get(`language:provider-${b.modelRowId}/vendor-${b.modelRowId}`)!

    expect(forA).toContain('【用户】交给你的任务')
    expect(forA).toContain('改 schema')
    expect(forA).not.toContain('> 验证方案')
    expect(forB).toContain('验证方案')
  })

  it('协作协议告诉每个人身边有谁在并行、看不到对方本轮的产出', async () => {
    const [a, b] = [member(0), member(1)]
    mocks.conversation = configuredConversation([a, b])
    for (const item of [a, b]) mocks.models.set(item.modelRowId, model(item.modelRowId))
    outputFor(a, '@用户 完成')
    outputFor(b, '@用户 完成')

    sendGroupMessage(sender() as never, input(`${mention(a)} 甲。${mention(b)} 乙`))
    await waitForTerminal()

    const systemOf = (target: GroupMember): string =>
      String(
        mocks.streamOptions.find(
          (options) =>
            options.model === `language:provider-${target.modelRowId}/vendor-${target.modelRowId}`
        )!.system
      )
    expect(systemOf(a)).toContain(`@${b.name}`)
    expect(systemOf(a)).toContain('看不到彼此本轮的产出')
    expect(systemOf(b)).toContain(`@${a.name}`)
  })

  it('agent 一次交接多位,他们同样并行接棒', async () => {
    const [a, b, c] = [member(0), member(1), member(2)]
    mocks.conversation = configuredConversation([a, b, c])
    for (const item of [a, b, c]) mocks.models.set(item.modelRowId, model(item.modelRowId))
    outputFor(a, `设计稿\n${mention(b)} 补用例\n${mention(c)} 同步文档`)
    outputFor(b, '@用户 用例好了')
    outputFor(c, '@用户 文档好了')

    sendGroupMessage(sender() as never, input(`${mention(a)} 出方案`))
    await waitForTerminal()

    // 3 棒派活 + 1 棒汇合(分叉 ≥2 条时发起者会被叫回来收口)
    expect(mocks.streamText).toHaveBeenCalledTimes(4)
    const authors = mocks.messages.filter((m) => m.role === 'assistant').map((m) => m.author)
    expect(new Set(authors)).toEqual(new Set([a.id, b.id, c.id]))
  })

  it('同一个人被两条分支同时点名时串行接棒,后一棒能看到前一棒的产出', async () => {
    const [a, b, c] = [member(0), member(1), member(2)]
    mocks.conversation = configuredConversation([a, b, c])
    for (const item of [a, b, c]) mocks.models.set(item.modelRowId, model(item.modelRowId))
    outputFor(a, `甲的结论\n${mention(c)} 汇总一下`)
    outputFor(b, `乙的结论\n${mention(c)} 汇总一下`)
    outputFor(c, '@用户 汇总完了(一)', '@用户 汇总完了(二)')

    sendGroupMessage(sender() as never, input(`${mention(a)} 甲。${mention(b)} 乙`))
    await waitForTerminal()

    const cMessages = mocks.messages.filter((m) => m.author === c.id)
    expect(cMessages).toHaveLength(2)
    // 串行的证据:第二棒的群聊记录里已经有第一棒的产出
    const cTranscripts = mocks.streamOptions
      .filter(
        (options) => options.model === `language:provider-${c.modelRowId}/vendor-${c.modelRowId}`
      )
      .map((options) => (options.messages as Array<{ content: string }>)[0].content)
    expect(cTranscripts).toHaveLength(2)
    expect(cTranscripts[1]).toContain('汇总完了(一)')
  })

  it('一条分支报错不影响另一条,收口仍然只有一次 chain-done', async () => {
    const [a, b] = [member(0), member(1)]
    mocks.conversation = configuredConversation([a, b])
    for (const item of [a, b]) mocks.models.set(item.modelRowId, model(item.modelRowId))
    outputFor(a, new Error('供应商「x」缺少 Base URL'))
    outputFor(b, '@用户 我这边正常完成')

    sendGroupMessage(sender() as never, input(`${mention(a)} 甲。${mention(b)} 乙`))
    await waitForTerminal()

    expect(mocks.events.some((event) => event.type === 'error')).toBe(true)
    expect(mocks.messages.find((m) => m.author === a.id)).toMatchObject({ status: 'error' })
    expect(mocks.messages.find((m) => m.author === b.id)).toMatchObject({ status: 'complete' })
    expect(mocks.events.filter((event) => event.type === 'chain-done')).toHaveLength(1)
  })
})

/**
 * 接力停不下来的根因不是没有闸,是**闸只在程序里、模型看不见**:
 * "@ 下一位"零成本,"@用户 收口"要一个更强的判断,规则不对称,讨论自然发散。
 * 这组用例钉住"预算摆到模型面前"和"评审必须给二元结论"。
 */
describe('接力收敛', () => {
  function systemOf(index: number): string {
    return String(mocks.streamOptions[index].system)
  }

  it('每棒告诉模型第几棒、还剩几棒', async () => {
    const [a, b] = [member(0), member(1)]
    mocks.conversation = configuredConversation([a, b])
    for (const item of [a, b]) mocks.models.set(item.modelRowId, model(item.modelRowId))
    mocks.outputs.push(mention(b), '@用户 完成')

    sendGroupMessage(sender() as never, input(mention(a)))
    await waitForTerminal()

    expect(systemOf(0)).toContain('这是第 1 棒')
    expect(systemOf(0)).toMatch(/还剩 \d+ 棒/)
    // 第二棒的剩余必须比第一棒少:预算要真的在递减,不能是句装饰
    const remaining = (index: number): number => Number(/还剩 (\d+) 棒/.exec(systemOf(index))![1])
    expect(remaining(1)).toBe(remaining(0) - 1)
  })

  it('预算见底时把话说死:这一棒必须收口,不许再交接', async () => {
    const members = MEMBER_IDS.map((_id, index) => member(index))
    mocks.conversation = configuredConversation(members)
    for (const item of members) mocks.models.set(item.modelRowId, model(item.modelRowId))
    mocks.outputs.push(...members.slice(1).map(mention))

    sendGroupMessage(sender() as never, input(mention(members[0])))
    await waitForTerminal()

    const last = systemOf(mocks.streamOptions.length - 1)
    expect(last).toContain('预算见底了')
    expect(last).toContain('不要再 @ 任何成员')
    // 预算充裕的第一棒不该出现收口指令,否则一上来就草草了事
    expect(systemOf(0)).not.toContain('预算见底了')
  })

  it('协作协议要求评审给二元结论,并堵死"还能优化"这条交接理由', async () => {
    const configured = member(0)
    mocks.conversation = configuredConversation([configured])
    mocks.models.set(configured.modelRowId, model(configured.modelRowId))
    mocks.outputs.push('@用户 完成')

    sendGroupMessage(sender() as never, input(mention(configured)))
    await waitForTerminal()

    const system = systemOf(0)
    expect(system).toContain('结论:通过')
    expect(system).toContain('阻断性问题')
    expect(system).toContain('不构成交接理由')
    expect(system).toContain('返工最多一轮')
  })
})

/**
 * 并行只解决了速度:不汇合的话用户看到 N 篇互不知道对方存在的文档,
 * 合并和挑冲突全靠他自己脑补。汇合把控制权交回派活的那个人。
 */
describe('并行汇合', () => {
  function outputFor(target: GroupMember, ...values: Array<string | Error>): void {
    mocks.outputsByModel.set(`language:provider-${target.modelRowId}/vendor-${target.modelRowId}`, [
      ...values
    ])
  }

  function hopsOf(target: GroupMember): Array<Record<string, unknown>> {
    return mocks.streamOptions.filter(
      (options) =>
        options.model === `language:provider-${target.modelRowId}/vendor-${target.modelRowId}`
    )
  }

  it('分叉两条 → 发起者被叫回来收口,且看得到两条分支的产出', async () => {
    const [a, b, c] = [member(0), member(1), member(2)]
    mocks.conversation = configuredConversation([a, b, c])
    for (const item of [a, b, c]) mocks.models.set(item.modelRowId, model(item.modelRowId))
    outputFor(a, `方案\n${mention(b)} 出用例\n${mention(c)} 出文档`, '@用户 汇总完毕')
    outputFor(b, '@用户 用例好了')
    outputFor(c, '@用户 文档好了')

    sendGroupMessage(sender() as never, input(`${mention(a)} 出方案`))
    await waitForTerminal()

    const aHops = hopsOf(a)
    expect(aHops).toHaveLength(2)

    // 汇合棒的 system 点名了它派出去的两位,并把"不要重写"写死
    const merge = String(aHops[1].system)
    expect(merge).toContain('这一棒是汇合')
    expect(merge).toContain(`@${b.name}`)
    expect(merge).toContain(`@${c.name}`)
    expect(merge).toContain('不要重写他们的文档')

    // 汇合棒的群聊记录里必须已经有两条分支的产出,否则合并就是空对空
    const transcript = (aHops[1].messages as Array<{ content: string }>)[0].content
    expect(transcript).toContain('用例好了')
    expect(transcript).toContain('文档好了')
  })

  it('只交接一条不汇合:线性接力时那位手上本来就有全部上下文', async () => {
    const [a, b] = [member(0), member(1)]
    mocks.conversation = configuredConversation([a, b])
    for (const item of [a, b]) mocks.models.set(item.modelRowId, model(item.modelRowId))
    outputFor(a, `方案\n${mention(b)} 接着做`)
    outputFor(b, '@用户 完成')

    sendGroupMessage(sender() as never, input(`${mention(a)} 出方案`))
    await waitForTerminal()

    expect(hopsOf(a)).toHaveLength(1)
    expect(mocks.streamText).toHaveBeenCalledTimes(2)
  })

  it('用户直接 @ 多位时不自动汇合:这一层的派活人是用户,收口也归他', async () => {
    const [a, b] = [member(0), member(1)]
    mocks.conversation = configuredConversation([a, b])
    for (const item of [a, b]) mocks.models.set(item.modelRowId, model(item.modelRowId))
    outputFor(a, '@用户 甲完成')
    outputFor(b, '@用户 乙完成')

    sendGroupMessage(sender() as never, input(`${mention(a)} 甲。${mention(b)} 乙`))
    await waitForTerminal()

    expect(mocks.streamText).toHaveBeenCalledTimes(2)
    expect(mocks.streamOptions.some((o) => String(o.system).includes('这一棒是汇合'))).toBe(false)
  })

  it('预算不够时静默跳过汇合,不发拦停:分支的文档已经产出了,少一次合并是降级不是失败', async () => {
    const members = MEMBER_IDS.map((_id, index) => member(index))
    mocks.conversation = configuredConversation(members)
    for (const item of members) mocks.models.set(item.modelRowId, model(item.modelRowId))
    // 一路线性接力把棒数烧到上限,最后一位再分叉两条 —— 汇合时预算已经见底
    members.slice(1, -2).forEach((item, index) => outputFor(item, mention(members[index + 2])))
    outputFor(members[0], mention(members[1]))
    const [x, y] = members.slice(-2)
    outputFor(members[members.length - 3], `${mention(x)} 甲\n${mention(y)} 乙`)

    sendGroupMessage(sender() as never, input(mention(members[0])))
    await waitForTerminal()

    // 拦停只应该来自正常的接力,不该来自汇合棒
    const stopped = mocks.events.filter((e) => e.type === 'chain-stopped')
    for (const event of stopped) {
      expect(event.type === 'chain-stopped' && event.nextMemberId).not.toBe(
        members[members.length - 3].id
      )
    }
    expect(mocks.events.filter((e) => e.type === 'chain-done')).toHaveLength(1)
  })
})

/**
 * 剩余棒数是压力,清单才是**完成的定义**——"整体完成了没有"不是任何单个
 * 专业角色能判断的,得把全局进度摆到每个人面前。
 */
describe('交付清单注入', () => {
  it('每棒带上清单与进度,已交的列标题、未交的点名', async () => {
    const [a, b] = [member(0, { deliverable: '需求文档' }), member(1, { deliverable: '架构文档' })]
    mocks.conversation = configuredConversation([a, b])
    for (const item of [a, b]) mocks.models.set(item.modelRowId, model(item.modelRowId))
    mocks.outputs.push(`# 需求文档:记账\n\n正文\n\n${mention(b)} 出架构`, '@用户 完成')

    sendGroupMessage(sender() as never, input(mention(a)))
    await waitForTerminal()

    // 第一棒的清单里就有它自己那项(未交):这一棒该交什么、怎么才算交,
    // 是它最需要知道的事
    const first = String(mocks.streamOptions[0].system)
    expect(first).toContain('本轮交付清单(0/1)')
    expect(first).toContain(`**未交** 需求文档(@${a.name})`)

    // 第二棒看得到第一棒交了什么、自己那份还没交
    const second = String(mocks.streamOptions[1].system)
    expect(second).toContain('本轮交付清单')
    expect(second).toContain('已交 需求文档')
    expect(second).toContain('《需求文档:记账》')
    expect(second).toContain(`**未交** 架构文档(@${b.name})`)
    expect(second).toContain('一级标题')
  })

  it('清单齐了就提示收口,不许再开新话题', async () => {
    const configured = member(0, { deliverable: '需求文档' })
    mocks.conversation = configuredConversation([configured])
    mocks.models.set(configured.modelRowId, model(configured.modelRowId))
    // 第一棒交付,第二棒(它自己被 @ 回来)就该看到"齐了"
    mocks.outputs.push('# 需求文档\n\n正文', '@用户 完成')

    sendGroupMessage(sender() as never, input(mention(configured)))
    await waitForTerminal()
    mocks.events.length = 0
    mocks.streamOptions.length = 0
    mocks.outputs.push('@用户 复核完成')

    sendGroupMessage(sender() as never, input(mention(configured)))
    await waitForTerminal()

    const system = String(mocks.streamOptions[0].system)
    expect(system).toContain('本轮交付清单(1/1)')
    expect(system).toContain('清单已经齐了')
  })

  it('汇合棒被要求用二级标题,免得把自己的专业文档从清单里挤掉', async () => {
    const [a, b, c] = [member(0), member(1), member(2)]
    mocks.conversation = configuredConversation([a, b, c])
    for (const item of [a, b, c]) mocks.models.set(item.modelRowId, model(item.modelRowId))
    mocks.outputsByModel.set(`language:provider-${a.modelRowId}/vendor-${a.modelRowId}`, [
      `# 方案\n\n${mention(b)} 甲\n${mention(c)} 乙`,
      '## 汇总\n\n没有冲突\n\n@用户 齐了'
    ])

    sendGroupMessage(sender() as never, input(mention(a)))
    await waitForTerminal()

    const merge = mocks.streamOptions.find((o) => String(o.system).includes('这一棒是汇合'))!
    expect(String(merge.system)).toContain('用二级标题开头')
    expect(String(merge.system)).toContain('挤掉')
  })
})
