import { MockLanguageModelV3, simulateReadableStream } from 'ai/test'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { WebContents } from 'electron'
import type { ChatStreamEvent, Conversation, Model, Project } from '../../shared/types'

/**
 * 服务级致命一致性测试:一次有效编辑已提交后,注入一个致命本地错误
 * (编辑器抛非预期异常),断言 run 以 error 收尾且**不产出新 artifact**——
 * 与 VFS 状态存疑的版本绝不能落库。
 */

const obs = vi.hoisted(() => ({ runFinishes: [] as Record<string, unknown>[] }))
vi.mock('../db/repo/ai-observability', () => ({
  startRun: () => 'run-1',
  startModelStep: vi.fn(),
  finishModelStep: vi.fn(),
  startTool: vi.fn(),
  updateToolPhase: vi.fn(),
  finishTool: vi.fn(),
  finishRun: (input: Record<string, unknown>) => obs.runFinishes.push(input),
  markInterruptedRuns: vi.fn(),
  cleanupDiagnostics: vi.fn()
}))

const state = vi.hoisted(() => ({
  msgCounter: 0,
  createArtifactVersion: vi.fn(() => ({ id: 'artifact-new' })),
  updateMessage: vi.fn(),
  llm: null as unknown
}))

vi.mock('../db/repo/conversation', () => ({
  getConversation: (): Conversation => ({
    id: 'c1',
    projectId: 'p1',
    title: '设计',
    kind: 'design',
    settings: null,
    createdAt: '',
    updatedAt: ''
  }),
  touchConversation: vi.fn(),
  autoTitle: vi.fn()
}))
vi.mock('../db/repo/project', () => ({
  getProject: (): Project =>
    ({
      id: 'p1',
      name: '项目',
      stack: 'html',
      designMode: 'design',
      targets: null,
      libs: null,
      description: '',
      styleBrief: '冷灰工作台',
      settings: null,
      createdAt: '',
      updatedAt: ''
    }) as Project,
  setProjectStyleBrief: vi.fn(),
  touchProject: vi.fn()
}))
vi.mock('../db/repo/artifact', () => ({
  createArtifactVersion: state.createArtifactVersion,
  getArtifactFiles: () => [{ path: 'a.css', content: '.hero { color: red; }\n' }],
  latestArtifact: () => ({ id: 'artifact-base', version: 1 })
}))
vi.mock('../db/repo/message', () => ({
  createMessage: (input: Record<string, unknown>) => ({
    id: `msg-${++state.msgCounter}`,
    parts: [],
    ...input
  }),
  listMessages: () => [],
  updateMessage: state.updateMessage
}))
vi.mock('../db/repo/model', () => ({
  getModel: (): Model =>
    ({
      id: 'model-row-1',
      providerId: 'prov-1',
      modelId: 'mock-model',
      displayName: 'Mock',
      type: 'chat',
      abilities: ['tools'],
      contextWindow: 64_000,
      enabled: true,
      isBuiltin: false,
      sortOrder: 0
    }) as unknown as Model
}))
vi.mock('../db/repo/provider', () => ({
  getProviderRowById: () => ({
    id: 'prov-1',
    slug: 'mock',
    name: 'Mock',
    adapter: 'openai',
    baseUrl: null,
    apiKeyCipher: 'cipher',
    keyStorage: 'safe',
    enabled: true,
    updatedAt: 'now'
  })
}))
vi.mock('../crypto', () => ({ decryptSecret: () => 'sk-test' }))
vi.mock('@ai-sdk/openai', () => ({ createOpenAI: () => () => state.llm }))
vi.mock('../config', () => ({
  readConfig: () => ({
    openaiCompat: { store: false, encryptedReasoning: false },
    assistantModel: null
  })
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
vi.mock('./style-brief', () => ({
  awaitMarkerUsageBeforeCommit: async (u: PromiseLike<unknown>, c: () => Promise<unknown>) => ({
    usage: await u,
    commit: await c()
  }),
  buildStyleBriefTools: () => ({}),
  commitMarkerStyleBrief: () => null,
  createInitialStyleWriteGate: () => null,
  markerCompletionOutcome: () => 'complete',
  renderStyleBriefPrompt: () => ''
}))
vi.mock('./ask-user', () => ({
  askUser: vi.fn(),
  buildAskUserTool: () => ({}),
  releaseQuestions: vi.fn()
}))
vi.mock('./image-tools', () => ({ buildImageTools: () => ({}) }))
vi.mock('./capture-tools', () => ({ buildCaptureTools: () => ({}) }))
vi.mock('../preview/session-registry', () => ({
  registerSessionPreview: vi.fn(),
  unregisterSessionPreview: vi.fn()
}))
vi.mock('./local-tools', () => ({ buildLocalTools: () => ({}), localScopePrompt: () => '' }))
vi.mock('./time-tools', () => ({ buildTimeTools: () => ({}) }))
vi.mock('./context', () => ({ buildHistory: () => [] }))
// 注入点:锚点编辑器抛非预期异常 = 本地一致性坏了(致命)
vi.mock('./string-edits', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./string-edits')>()
  return {
    ...actual,
    MagicStringBatchEditor: class {
      apply(): never {
        throw new TypeError('内部状态损坏')
      }
    }
  }
})

import { sendChat } from './chat-service'

type V3StreamResult = Awaited<ReturnType<InstanceType<typeof MockLanguageModelV3>['doStream']>>
type V3StreamPart = V3StreamResult['stream'] extends ReadableStream<infer P> ? P : never

const USAGE = {
  inputTokens: { total: 100, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 10, text: 10, reasoning: undefined }
}

beforeEach(() => {
  obs.runFinishes.length = 0
  state.createArtifactVersion.mockClear()
  state.updateMessage.mockClear()
})

describe('致命一致性错误', () => {
  it('有效编辑已提交后发生致命错误:run 记 error,不产出新 artifact', async () => {
    let call = 0
    state.llm = new MockLanguageModelV3({
      doStream: async () => {
        call += 1
        const chunks: V3StreamPart[] =
          call === 1
            ? [
                { type: 'stream-start', warnings: [] },
                {
                  type: 'tool-call',
                  toolCallId: 't-edit',
                  toolName: 'edit_file',
                  input: JSON.stringify({
                    path: 'a.css',
                    old_string: 'color: red',
                    new_string: 'color: blue'
                  })
                },
                {
                  type: 'tool-call',
                  toolCallId: 't-anchor',
                  toolName: 'apply_string_edits',
                  input: JSON.stringify({
                    operations: [{ type: 'remove', anchor_id: 'whatever' }]
                  })
                },
                {
                  type: 'finish',
                  finishReason: { unified: 'tool-calls' as const, raw: 'tool_calls' },
                  usage: USAGE
                }
              ]
            : [
                { type: 'stream-start', warnings: [] },
                { type: 'text-start', id: '0' },
                { type: 'text-delta', id: '0', delta: '收尾' },
                { type: 'text-end', id: '0' },
                {
                  type: 'finish',
                  finishReason: { unified: 'stop' as const, raw: 'stop' },
                  usage: USAGE
                }
              ]
        return { stream: simulateReadableStream({ chunks }) }
      }
    })

    const events: ChatStreamEvent[] = []
    const sender = {
      isDestroyed: () => false,
      send: (_ch: string, ev: ChatStreamEvent) => events.push(ev)
    } as unknown as WebContents

    sendChat(sender, {
      conversationId: 'c1',
      text: '把主色改成蓝色',
      providerId: 'prov-1',
      modelId: 'model-row-1'
    })
    await vi.waitFor(() => {
      expect(obs.runFinishes.length).toBe(1)
    })

    // 有效编辑确实提交过(第一次 file-patch 事件已发)
    expect(events.some((e) => e.type === 'file-patch' && e.path === 'a.css')).toBe(true)
    // 但致命错误后:run 记 error,artifact 仓库一次都没被调
    expect(obs.runFinishes[0].status).toBe('error')
    expect(state.createArtifactVersion).not.toHaveBeenCalled()
    // 消息以 error 收尾,渲染层收到 error 事件且不带新版本号
    const errorEvent = events.find((e) => e.type === 'error')
    expect(errorEvent).toBeDefined()
    expect((errorEvent as { artifactId?: string | null }).artifactId ?? null).toBeNull()
  })
})
