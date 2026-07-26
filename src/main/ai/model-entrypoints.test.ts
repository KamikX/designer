import { MockLanguageModelV3, simulateReadableStream } from 'ai/test'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { WebContents } from 'electron'
import type { Conversation, GroupMember, Model } from '../../shared/types'

/**
 * 入口覆盖测试:四个真实的语言模型调用点(chat / group / assistant /
 * provider_test)都必须创建追踪。
 *
 * 用真的 streamText / generateText + MockLanguageModelV3——追踪靠 AI SDK
 * 生命周期回调驱动,mock 掉 'ai' 就等于没测。只 mock 数据库与文件系统外围。
 */

const obs = vi.hoisted(() => {
  const data = {
    runs: [] as Record<string, unknown>[],
    steps: [] as Record<string, unknown>[],
    stepFinishes: [] as Record<string, unknown>[],
    runFinishes: [] as Record<string, unknown>[]
  }
  return {
    ...data,
    reset(): void {
      data.runs.length = 0
      data.steps.length = 0
      data.stepFinishes.length = 0
      data.runFinishes.length = 0
    }
  }
})

vi.mock('../db/repo/ai-observability', () => ({
  startRun: (input: Record<string, unknown>) => {
    obs.runs.push(input)
    return `run-${obs.runs.length}`
  },
  startModelStep: (input: Record<string, unknown>) => obs.steps.push(input),
  finishModelStep: (input: Record<string, unknown>) => obs.stepFinishes.push(input),
  startTool: vi.fn(),
  updateToolPhase: vi.fn(),
  finishTool: vi.fn(),
  finishRun: (input: Record<string, unknown>) => obs.runFinishes.push(input),
  markInterruptedRuns: vi.fn(),
  cleanupDiagnostics: vi.fn()
}))

const state = vi.hoisted(() => ({
  conversation: null as Conversation | null,
  messages: [] as unknown[],
  model: null as Model | null,
  llm: null as unknown,
  msgCounter: 0
}))

/* ---------- 数据库与外围 mock ---------- */
vi.mock('../db/repo/conversation', () => ({
  getConversation: () => state.conversation,
  touchConversation: vi.fn(),
  autoTitle: vi.fn()
}))
vi.mock('../db/repo/message', () => ({
  createMessage: (input: Record<string, unknown>) => ({
    id: `msg-${++state.msgCounter}`,
    parts: [],
    ...input
  }),
  listMessages: () => state.messages,
  updateMessage: vi.fn()
}))
vi.mock('../db/repo/model', () => ({
  getModel: () => state.model,
  listModels: () => (state.model ? [state.model] : [])
}))
vi.mock('../db/repo/provider', () => ({
  getProviderRowById: () => ({
    id: 'prov-1',
    slug: 'mock-openai',
    name: 'Mock',
    adapter: 'openai',
    baseUrl: null,
    apiKeyCipher: 'cipher',
    keyStorage: 'safe',
    enabled: true,
    updatedAt: '2026-07-25 00:00:00'
  })
}))
vi.mock('../crypto', () => ({ decryptSecret: () => 'sk-test' }))
vi.mock('@ai-sdk/openai', () => ({
  createOpenAI: () => () => state.llm
}))
vi.mock('../config', () => ({
  readConfig: () => ({
    openaiCompat: { store: false, encryptedReasoning: false },
    assistantModel: { providerId: 'prov-1', modelId: 'model-row-1' }
  })
}))
vi.mock('../db/repo/project', () => ({
  getProject: () => null,
  setProjectStyleBrief: vi.fn(),
  touchProject: vi.fn()
}))
vi.mock('../db/repo/artifact', () => ({
  createArtifactVersion: vi.fn(),
  getArtifactFiles: () => [],
  latestArtifact: () => null
}))
vi.mock('../db/repo/asset', () => ({ getAssetRecord: () => null }))
vi.mock('../storage/service', () => ({ resolveAsset: vi.fn() }))
vi.mock('../skills/scan', () => ({ scanSkills: () => [], skillRoots: () => [] }))
vi.mock('../skills/catalog', () => ({ skillCatalog: () => '' }))
vi.mock('../skills/targets', () => ({ loadTargetTemplates: () => [] }))
vi.mock('../skills/tools', () => ({ buildSkillTools: () => ({}) }))
vi.mock('../skills/install-tools', () => ({ buildInstallTools: () => ({}) }))
vi.mock('../mcp/tools', () => ({ connectMcpTools: vi.fn() }))
vi.mock('../web/tools', () => ({ buildWebTools: () => ({}) }))
vi.mock('../web/session', () => ({ closeBrowserSession: vi.fn() }))
vi.mock('../workspace/roots', () => ({ addRoot: vi.fn(), listRoots: () => [] }))
vi.mock('../workspace/detect', () => ({ detectPaths: () => ({ resolved: [], missing: [] }) }))
vi.mock('../preview/errors', () => ({
  pendingPreviewError: () => null,
  previewErrorPrompt: () => ''
}))
vi.mock('./slop-lint', () => ({ lintArtifact: () => [] }))
vi.mock('./lint-store', () => ({ pendingLint: () => '', recordLint: vi.fn() }))
vi.mock('./prompts', () => ({ buildSystemPrompt: () => '' }))
vi.mock('./prompts/chat', () => ({ buildChatPrompt: () => '' }))
vi.mock('./prompts/targets', () => ({
  renderCompatNote: () => '',
  renderTargetTemplates: () => '',
  routeActiveTargets: () => ({ active: [], compat: [] }),
  targetContractPrompt: () => ''
}))
vi.mock('./style-brief', () => ({
  awaitMarkerUsageBeforeCommit: async (
    usage: PromiseLike<unknown>,
    commit: () => Promise<unknown>
  ) => ({ usage: await usage, commit: await commit() }),
  buildStyleBriefTools: () => ({}),
  commitMarkerStyleBrief: () => null,
  createInitialStyleWriteGate: () => null,
  markerCompletionOutcome: () => 'complete',
  renderStyleBriefPrompt: () => ''
}))
vi.mock('./tools', () => ({ buildFileTools: () => ({}) }))
vi.mock('./ask-user', () => ({
  askUser: vi.fn(),
  buildAskUserTool: () => ({}),
  releaseQuestions: vi.fn()
}))
vi.mock('./image-tools', () => ({ buildImageTools: () => ({}) }))
vi.mock('./local-tools', () => ({ buildLocalTools: () => ({}), localScopePrompt: () => '' }))
vi.mock('./time-tools', () => ({ buildTimeTools: () => ({}) }))
vi.mock('./context', () => ({ buildHistory: () => [] }))

import { sendChat } from './chat-service'
import { sendGroupMessage } from './group-service'
import { condenseIfLong } from './assistant'
import { testProvider } from './registry'

// 从 Mock 类身上反推 v3 分片/结果类型:'ai/test' 不导出类型,别硬 import
type V3StreamResult = Awaited<ReturnType<InstanceType<typeof MockLanguageModelV3>['doStream']>>
type V3StreamPart = V3StreamResult['stream'] extends ReadableStream<infer P> ? P : never
type V3GenerateResult = Awaited<ReturnType<InstanceType<typeof MockLanguageModelV3>['doGenerate']>>

const V3_USAGE = {
  inputTokens: { total: 100, noCache: 60, cacheRead: 40, cacheWrite: undefined },
  outputTokens: { total: 20, text: 12, reasoning: 8 }
}

function streamingModel(text = '好的,我看看。'): MockLanguageModelV3 {
  const chunks: V3StreamPart[] = [
    { type: 'stream-start', warnings: [] },
    { type: 'text-start', id: '0' },
    { type: 'text-delta', id: '0', delta: text },
    { type: 'text-end', id: '0' },
    { type: 'finish', finishReason: { unified: 'stop' as const, raw: 'stop' }, usage: V3_USAGE }
  ]
  return new MockLanguageModelV3({
    doStream: async () => ({ stream: simulateReadableStream({ chunks }) })
  })
}

function generatingModel(): MockLanguageModelV3 {
  return new MockLanguageModelV3({
    doGenerate: async (): Promise<V3GenerateResult> => ({
      content: [{ type: 'text', text: '提炼后的要点' }],
      finishReason: { unified: 'stop' as const, raw: 'stop' },
      usage: V3_USAGE,
      warnings: []
    })
  })
}

function chatModel(abilities: string[]): Model {
  return {
    id: 'model-row-1',
    providerId: 'prov-1',
    modelId: 'mock-model',
    displayName: 'Mock 模型',
    type: 'chat',
    abilities,
    contextWindow: 64_000,
    enabled: true,
    isBuiltin: false,
    sortOrder: 0
  } as unknown as Model
}

function fakeSender(): WebContents {
  return { isDestroyed: () => false, send: vi.fn() } as unknown as WebContents
}

async function waitRunFinished(count = 1): Promise<void> {
  await vi.waitFor(() => {
    expect(obs.runFinishes.length).toBeGreaterThanOrEqual(count)
  })
}

beforeEach(() => {
  obs.reset()
  state.messages = []
  state.msgCounter = 0
})

describe('模型入口全覆盖', () => {
  it('纯聊天:scene=chat,step 带完整用量收尾', async () => {
    state.conversation = {
      id: 'c1',
      projectId: null,
      title: '',
      kind: 'chat',
      settings: null,
      createdAt: '',
      updatedAt: ''
    }
    state.model = chatModel(['tools'])
    state.llm = streamingModel()

    sendChat(fakeSender(), {
      conversationId: 'c1',
      text: '你好',
      providerId: 'prov-1',
      modelId: 'model-row-1'
    })
    await waitRunFinished()

    expect(obs.runs).toHaveLength(1)
    expect(obs.runs[0].scene).toBe('chat')
    expect(obs.runs[0].providerSlug).toBe('mock-openai')
    // 请求发出前有 pending step,收尾带归一化用量
    expect(obs.steps).toHaveLength(1)
    const finish = obs.stepFinishes.find((f) => f.usage) as { usage: { inputTokens: number } }
    expect(finish.usage.inputTokens).toBe(100)
    expect(obs.runFinishes[0].status).toBe('complete')
    // run 级首个输出时间被记录
    expect(obs.runFinishes[0].firstOutputAt).toBeTruthy()
  })

  it('群组接力:scene=group,每一棒一个 run', async () => {
    const member: GroupMember = {
      id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
      name: '产品经理',
      color: '#123456',
      duty: '需求',
      deliverable: '需求列表',
      persona: '你是产品经理',
      modelRowId: 'model-row-1',
      skillIds: []
    }
    state.conversation = {
      id: 'g1',
      projectId: null,
      title: '群',
      kind: 'group',
      settings: { members: [member] },
      createdAt: '',
      updatedAt: ''
    }
    state.model = chatModel(['tools'])
    state.llm = streamingModel('分析完毕,没有下一棒。')

    sendGroupMessage(fakeSender(), {
      conversationId: 'g1',
      text: `@[产品经理](member:${member.id}) 请整理需求`
    })
    await waitRunFinished()

    expect(obs.runs[0].scene).toBe('group')
    expect(obs.runs[0].conversationId).toBe('g1')
    expect(obs.stepFinishes.some((f) => f.usage)).toBe(true)
  })

  it('辅助模型提炼:scene=assistant,没有消息也计量', async () => {
    state.model = chatModel([])
    state.llm = generatingModel()

    const out = await condenseIfLong('长'.repeat(9000))
    expect(out.summarized).toBe(true)
    await waitRunFinished()

    expect(obs.runs[0].scene).toBe('assistant')
    expect(obs.runs[0].messageId).toBeNull()
    const finish = obs.stepFinishes.find((f) => f.usage) as { usage: { inputTokens: number } }
    expect(finish.usage.inputTokens).toBe(100)
  })

  it('供应商连通性测试:scene=provider_test,真实计费计入用量', async () => {
    state.model = chatModel([])
    state.llm = generatingModel()

    const result = await testProvider('prov-1')
    expect(result.ok).toBe(true)
    await waitRunFinished()

    expect(obs.runs[0].scene).toBe('provider_test')
    expect(obs.stepFinishes.some((f) => f.usage)).toBe(true)
    expect(obs.runFinishes[0].status).toBe('complete')
  })

  it('上游失败:run 以 error 收尾,pending step 不消失', async () => {
    state.conversation = {
      id: 'c2',
      projectId: null,
      title: '',
      kind: 'chat',
      settings: null,
      createdAt: '',
      updatedAt: ''
    }
    state.model = chatModel(['tools'])
    state.llm = new MockLanguageModelV3({
      doStream: async () => ({
        stream: simulateReadableStream({
          chunks: [
            { type: 'stream-start', warnings: [] },
            { type: 'error', error: new Error('上游挂了') }
          ]
        })
      })
    })

    sendChat(fakeSender(), {
      conversationId: 'c2',
      text: '你好',
      providerId: 'prov-1',
      modelId: 'model-row-1'
    })
    await waitRunFinished()

    expect(obs.runFinishes[0].status).toBe('error')
    // 请求行还在:被 finish 兜底成 error 收尾
    expect(obs.steps.length).toBeGreaterThanOrEqual(1)
    expect(obs.stepFinishes.some((f) => f.status === 'error')).toBe(true)
  })
})
