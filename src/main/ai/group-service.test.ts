import { beforeEach, describe, expect, it, vi } from 'vitest'
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
  getLanguageModel: vi.fn(),
  scanSkills: vi.fn(),
  skillCatalog: vi.fn(),
  skillRoots: vi.fn(),
  buildSkillTools: vi.fn(),
  buildLocalTools: vi.fn(),
  streamText: vi.fn()
}))

vi.mock('electron', () => ({ default: {}, app: {} }))

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

vi.mock('./registry', () => ({
  getLanguageModel: mocks.getLanguageModel,
  errorMessage: (error: unknown) => (error instanceof Error ? error.message : String(error))
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

vi.mock('ai', () => ({
  streamText: mocks.streamText
}))

import { sendGroupMessage } from './group-service'

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

function input(text: string, fallbackModelRowId?: string): GroupSendInput {
  return {
    conversationId: 'group-1',
    text,
    ...(fallbackModelRowId ? { fallbackModelRowId } : {})
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
    (draft: Omit<Message, 'id' | 'createdAt' | 'usage' | 'providerSlug' | 'artifactId'>) => {
      const created: Message = {
        ...draft,
        id: `message-${mocks.messages.length + 1}`,
        status: draft.status ?? 'complete',
        usage: null,
        providerSlug: null,
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
    mocks.models.set('model-research', model('model-research', 'provider-a', 'research-chat'))
    mocks.models.set('model-writing', model('model-writing', 'provider-b', 'writing-chat'))
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

    sendGroupMessage(
      sender() as never,
      input(`${mention(first)} 请开始`, 'missing-fallback-that-must-be-ignored')
    )
    expect((await waitForTerminal()).type).toBe('chain-done')

    expect(mocks.getLanguageModel.mock.calls).toEqual([
      ['provider-a', 'research-chat'],
      ['provider-b', 'writing-chat']
    ])
    expect(mocks.streamOptions.map((options) => options.model)).toEqual([
      'language:provider-a/research-chat',
      'language:provider-b/writing-chat'
    ])
    expect(
      mocks.skillCatalog.mock.calls.map(([skills]) => skills.map((skill) => skill.name))
    ).toEqual([['research'], ['writing']])
    expect(mocks.streamOptions[0].system).toContain('CATALOG:research')
    expect(mocks.streamOptions[0].system).not.toContain('CATALOG:writing')
    expect(mocks.streamOptions[1].system).toContain('CATALOG:writing')
    expect(mocks.streamOptions[1].system).not.toContain('CATALOG:research')
    expect(mocks.streamOptions[0].system).toContain('@研究员(职责1)')
    expect(mocks.streamOptions[0].system).toContain('@写作者(职责2)')
    expect(
      mocks.buildLocalTools.mock.calls.map(([roots]) => roots.map((root) => root.name))
    ).toEqual([
      ['workspace', 'skill:research'],
      ['workspace', 'skill:writing']
    ])
    expect(mocks.streamOptions[0].tools).toMatchObject({
      get_time: { kind: 'time' },
      activate_skill: { selected: ['research'] },
      read_local_file: { roots: ['workspace', 'skill:research'] }
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
    expect(assistantCreates).toMatchObject([
      { author: first.id, modelId: 'model-research' },
      { author: second.id, modelId: 'model-writing' }
    ])
  })

  it('新群忽略无效 fallbackModelRowId，只解析成员自己的模型', async () => {
    const configured = member(0, { modelRowId: 'member-model' })
    mocks.conversation = configuredConversation([configured])
    mocks.models.set('member-model', model('member-model'))
    mocks.outputs.push('@用户 完成')

    sendGroupMessage(sender() as never, input(`${mention(configured)} 开始`, 'disabled-fallback'))
    expect((await waitForTerminal()).type).toBe('chain-done')

    expect(mocks.getModel).toHaveBeenCalledWith('member-model')
    expect(mocks.getModel).not.toHaveBeenCalledWith('disabled-fallback')
  })
})

describe('legacy 群组兼容', () => {
  it('用 fallback 模型运行完整内置角色，并保持空技能', async () => {
    mocks.conversation = {
      ...configuredConversation([]),
      settings: { members: ['pm'] }
    }
    mocks.models.set('fallback-row', model('fallback-row', 'provider-old', 'old-chat'))
    mocks.outputs.push('@用户 完成')

    sendGroupMessage(sender() as never, input('@产品经理 请开始', 'fallback-row'))
    expect((await waitForTerminal()).type).toBe('chain-done')

    expect(mocks.getLanguageModel).toHaveBeenCalledWith('provider-old', 'old-chat')
    expect(mocks.skillCatalog).toHaveBeenCalledWith([], 64_000)
    expect(mocks.streamOptions[0].system).toContain('你是资深产品经理')
    expect(mocks.createMessage.mock.calls[1][0]).toMatchObject({
      author: 'pm',
      modelId: 'fallback-row'
    })
  })

  it('缺少 fallback 时把当前成员消息标错，并报告成员名称', async () => {
    mocks.conversation = {
      ...configuredConversation([]),
      settings: { members: ['pm'] }
    }

    sendGroupMessage(sender() as never, input('@产品经理 请开始'))
    await vi.waitFor(() => {
      expect(mocks.events.some((event) => event.type === 'error')).toBe(true)
    })

    expect(mocks.events.find((event) => event.type === 'error')).toMatchObject({
      type: 'error',
      message: expect.stringMatching(/产品经理.*回退模型/)
    })
    expect(mocks.messages.find((message) => message.author === 'pm')).toMatchObject({
      status: 'error',
      modelId: null
    })
    expect((await waitForTerminal()).type).toBe('chain-done')
  })
})

describe('链路停止与清理', () => {
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
      message: expect.stringContaining('重复接力')
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
