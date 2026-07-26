import { describe, expect, it } from 'vitest'
import type { RunTraceRepo, TraceClock } from './run-trace'
import { RunTraceCollector } from './run-trace'

/**
 * 用假仓库 + 假时钟验证生命周期:采集器的职责是把回调时序翻译成
 * 正确的仓储调用,时间必须来自注入的时钟,不许自己看表。
 */

interface Call {
  method: string
  args: Record<string, unknown>
}

function fakeRepo(): { calls: Call[]; repo: RunTraceRepo } {
  const calls: Call[] = []
  const record =
    (method: string) =>
    (args: unknown): string => {
      calls.push({ method, args: args as Record<string, unknown> })
      return 'run-1'
    }
  const repo = {
    startRun: record('startRun'),
    startModelStep: record('startModelStep'),
    finishModelStep: record('finishModelStep'),
    startTool: record('startTool'),
    updateToolPhase: record('updateToolPhase'),
    finishTool: record('finishTool'),
    finishRun: record('finishRun')
    // 测试替身只记录调用,形参宽化是刻意的
  } as unknown as RunTraceRepo
  return { calls, repo }
}

/** 每次取时间前进 1 秒,ISO 与单调钟同步推进 */
function fakeClock(): TraceClock & { tick: (ms: number) => void } {
  let mono = 0
  return {
    tick(ms: number) {
      mono += ms
    },
    nowIso() {
      return new Date(Date.UTC(2026, 6, 25, 10, 0, 0, mono)).toISOString()
    },
    monoMs() {
      return mono
    }
  }
}

function makeCollector(overrides?: Partial<ConstructorParameters<typeof RunTraceCollector>[0]>): {
  collector: RunTraceCollector
  calls: Call[]
  clock: ReturnType<typeof fakeClock>
} {
  const { calls, repo } = fakeRepo()
  const clock = fakeClock()
  const collector = new RunTraceCollector({
    scene: 'design',
    messageId: 'm1',
    conversationId: 'c1',
    projectId: 'p1',
    providerId: 'prov-1',
    providerSlug: 'openai',
    modelId: 'gpt-test',
    adapter: 'openai',
    repo,
    clock,
    ...overrides
  })
  return { collector, calls, clock }
}

const FULL_USAGE = {
  inputTokens: 100,
  inputTokenDetails: { noCacheTokens: 60, cacheReadTokens: 40, cacheWriteTokens: undefined },
  outputTokens: 20,
  outputTokenDetails: { textTokens: 12, reasoningTokens: 8 },
  totalTokens: 120
}

describe('完整成功链路', () => {
  it('startRun → 模型调用 → 首输出 → 工具三相 → stepEnd → finishRun', () => {
    const { collector, calls, clock } = makeCollector()
    collector.start()

    collector.modelCallStart('call-1')
    clock.tick(800)
    collector.markFirstOutput()
    clock.tick(200)

    collector.toolInputStart('tool-1', 'apply_patch')
    clock.tick(500)
    collector.toolInputEnd('tool-1', { path: 'pages/index.vue' }, 1200)
    collector.toolExecutionStart('tool-1')
    clock.tick(50)
    collector.markFirstFilePatch()
    collector.toolExecutionEnd('tool-1', {
      status: 'success',
      outputChars: 30,
      affectedFileCount: 1
    })

    clock.tick(100)
    collector.stepEnd('call-1', FULL_USAGE)
    collector.finish('complete')

    const sequence = calls.map((c) => c.method)
    expect(sequence).toEqual([
      'startRun',
      'startModelStep',
      'startTool',
      'updateToolPhase',
      'updateToolPhase',
      'finishTool',
      'finishModelStep',
      'finishRun'
    ])

    const stepFinish = calls.find((c) => c.method === 'finishModelStep')!.args
    expect(stepFinish.status).toBe('complete')
    expect(stepFinish.timeToFirstOutputMs).toBe(800)
    expect((stepFinish.usage as { inputTokens: number }).inputTokens).toBe(100)
    // provider raw 走白名单提取,不认识的形状保持 null——这里没有 raw
    expect((stepFinish.usage as { providerTotalTokens: unknown }).providerTotalTokens).toBeNull()

    const toolFinish = calls.find((c) => c.method === 'finishTool')!.args
    expect(toolFinish.status).toBe('success')
    expect(toolFinish.targetSummary).toBe('pages/index.vue')

    const runFinish = calls.find((c) => c.method === 'finishRun')!.args
    expect(runFinish.status).toBe('complete')
    expect(runFinish.firstOutputAt).toBe('2026-07-25T10:00:00.800Z')
    expect(runFinish.firstFileChangeAt).toBe('2026-07-25T10:00:01.550Z')
    expect(runFinish.toolCallCount).toBe(1)
    expect(runFinish.toolFailureCount).toBe(0)
  })
})

describe('异常路径', () => {
  it('模型请求抛错且没有 onStepEnd:同一行以 error 收尾,用量为空', () => {
    const { collector, calls } = makeCollector()
    collector.start()
    collector.modelCallStart('call-1')
    collector.modelCallEnd('call-1', {
      status: 'error',
      httpStatus: 500,
      errorCode: 'UPSTREAM_ERROR'
    })
    collector.finish('error')

    const finish = calls.find((c) => c.method === 'finishModelStep')!.args
    expect(finish.status).toBe('error')
    expect(finish.usage).toBeUndefined()
    expect(finish.errorCode).toBe('UPSTREAM_ERROR')
    expect(calls.find((c) => c.method === 'finishRun')!.args.status).toBe('error')
  })

  it('可恢复的工具失败计入失败数,run 仍可 complete', () => {
    const { collector, calls } = makeCollector()
    collector.start()
    collector.modelCallStart('call-1')
    collector.toolInputStart('tool-1', 'edit_file')
    collector.toolInputEnd('tool-1', { path: 'a.vue' }, 100)
    collector.toolExecutionStart('tool-1')
    collector.toolExecutionEnd('tool-1', {
      status: 'recoverable_error',
      errorCode: 'MATCH_NOT_FOUND',
      errorSummary: '旧文本不匹配 /Users/alice/x.vue'
    })
    collector.stepEnd('call-1', FULL_USAGE)
    collector.finish('complete')

    const toolFinish = calls.find((c) => c.method === 'finishTool')!.args
    expect(toolFinish.status).toBe('recoverable_error')
    // 错误摘要过了二次脱敏
    expect(String(toolFinish.errorSummary)).not.toContain('alice')

    const runFinish = calls.find((c) => c.method === 'finishRun')!.args
    expect(runFinish.status).toBe('complete')
    expect(runFinish.toolFailureCount).toBe(1)
  })

  it('中止:未收尾的工具与 step 都以 aborted 落库', () => {
    const { collector, calls } = makeCollector()
    collector.start()
    collector.modelCallStart('call-1')
    collector.toolInputStart('tool-1', 'write_file')
    collector.finish('aborted')

    expect(calls.find((c) => c.method === 'finishTool')!.args.status).toBe('aborted')
    expect(calls.find((c) => c.method === 'finishModelStep')!.args.status).toBe('aborted')
    expect(calls.find((c) => c.method === 'finishRun')!.args.status).toBe('aborted')
  })

  it('finish 幂等:重复调用只落一次库', () => {
    const { collector, calls } = makeCollector()
    collector.start()
    collector.finish('complete')
    collector.finish('error')
    expect(calls.filter((c) => c.method === 'finishRun')).toHaveLength(1)
  })

  it('仓储抛错不打断调用方', () => {
    const clock = fakeClock()
    const collector = new RunTraceCollector({
      scene: 'design',
      providerSlug: 'openai',
      modelId: 'gpt-test',
      repo: {
        startRun: () => {
          throw new Error('磁盘满了')
        },
        startModelStep: () => {
          throw new Error('磁盘满了')
        },
        finishModelStep: () => {
          throw new Error('磁盘满了')
        },
        startTool: () => {
          throw new Error('磁盘满了')
        },
        updateToolPhase: () => {
          throw new Error('磁盘满了')
        },
        finishTool: () => {
          throw new Error('磁盘满了')
        },
        finishRun: () => {
          throw new Error('磁盘满了')
        }
      },
      clock
    })
    expect(() => {
      collector.start()
      collector.modelCallStart('c1')
      collector.stepEnd('c1', FULL_USAGE)
      collector.finish('complete')
    }).not.toThrow()
  })
})

describe('特殊场景', () => {
  it('provider_test 没有消息/项目也要计量', () => {
    const { collector, calls } = makeCollector({
      scene: 'provider_test',
      messageId: null,
      conversationId: null,
      projectId: null
    })
    collector.start()
    collector.modelCallStart('call-1')
    collector.stepEnd('call-1', FULL_USAGE)
    collector.finish('complete')

    const start = calls.find((c) => c.method === 'startRun')!.args
    expect(start.scene).toBe('provider_test')
    expect(start.messageId).toBeNull()
    // 用量仍然进了聚合
    expect(calls.find((c) => c.method === 'finishModelStep')!.args.usage).toBeTruthy()
  })

  it('MCP 工具目标只留工具名,不看字段值', () => {
    const { collector, calls } = makeCollector()
    collector.start()
    collector.modelCallStart('call-1')
    collector.toolInputStart('tool-1', 'github_create_issue', { mcp: true })
    collector.toolInputEnd('tool-1', { title: 'sk-live-secret000000' }, 50)
    collector.toolExecutionStart('tool-1')
    collector.toolExecutionEnd('tool-1', { status: 'success' })
    collector.stepEnd('call-1', FULL_USAGE)
    collector.finish('complete')

    const toolFinish = calls.find((c) => c.method === 'finishTool')!.args
    expect(toolFinish.targetSummary).toBe('github_create_issue')
    expect(JSON.stringify(calls)).not.toContain('sk-live')
  })

  it('多 step:第二次 modelCallStart 递增 step 序号', () => {
    const { collector, calls } = makeCollector()
    collector.start()
    collector.modelCallStart('call-1')
    collector.stepEnd('call-1', FULL_USAGE)
    collector.modelCallStart('call-2')
    collector.stepEnd('call-2', FULL_USAGE)
    collector.finish('complete')

    const starts = calls.filter((c) => c.method === 'startModelStep')
    expect(starts[0].args.stepNumber).toBe(0)
    expect(starts[1].args.stepNumber).toBe(1)
  })
})
