import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { normalizeStepUsage } from '../../ai/usage'
import { MIGRATIONS } from '../migrations'
import * as schema from '../schema'

/**
 * 观测仓库测试跑在真 SQLite 内存库上:这里的核心风险全是事务边界、
 * 唯一键与级联语义,mock 掉数据库就什么都没测到。
 */

let sqlite: Database.Database
let testDb: BetterSQLite3Database<typeof schema>

vi.mock('../index', () => ({ getDb: () => testDb }))

import {
  cleanupDiagnostics,
  clearUsage,
  finishModelStep,
  finishRun,
  finishTool,
  getRunDiagnostics,
  markInterruptedRuns,
  queryDailyUsage,
  startModelStep,
  startRun,
  startTool,
  updateToolPhase
} from './ai-observability'

function runMigrations(conn: Database.Database): void {
  conn.pragma('foreign_keys = OFF')
  for (let v = 0; v < MIGRATIONS.length; v++) {
    conn.transaction(() => {
      conn.exec(MIGRATIONS[v])
      conn.pragma(`user_version = ${v + 1}`)
    })()
  }
  conn.pragma('foreign_keys = ON')
}

const USAGE = normalizeStepUsage({
  inputTokens: 100,
  inputTokenDetails: { noCacheTokens: 60, cacheReadTokens: 40, cacheWriteTokens: undefined },
  outputTokens: 20,
  outputTokenDetails: { textTokens: 12, reasoningTokens: 8 },
  totalTokens: 120
})

function seedRun(overrides?: Partial<Parameters<typeof startRun>[0]>): string {
  return startRun({
    messageId: 'm1',
    conversationId: 'c1',
    projectId: null,
    providerId: 'prov-1',
    providerSlug: 'openai',
    modelId: 'gpt-test',
    scene: 'design',
    startedAt: '2026-07-25T10:00:00.000Z',
    ...overrides
  })
}

function stepDefaults(
  runId: string,
  callId: string,
  startedAt = '2026-07-25T10:00:01.000Z'
): Parameters<typeof startModelStep>[0] {
  return {
    runId,
    callId,
    stepNumber: 0,
    providerId: 'prov-1',
    providerSlug: 'openai',
    modelId: 'gpt-test',
    startedAt
  }
}

beforeEach(() => {
  sqlite = new Database(':memory:')
  runMigrations(sqlite)
  testDb = drizzle(sqlite, { schema })
})

describe('日聚合与 run 去重', () => {
  it('同 run 同日多个 step 只给 run_count 加一次', () => {
    const runId = seedRun()
    startModelStep(stepDefaults(runId, 'call-1'))
    finishModelStep({
      runId,
      callId: 'call-1',
      status: 'complete',
      endedAt: '2026-07-25T10:00:05.000Z',
      usage: USAGE
    })
    startModelStep({ ...stepDefaults(runId, 'call-2'), stepNumber: 1 })
    finishModelStep({
      runId,
      callId: 'call-2',
      status: 'complete',
      endedAt: '2026-07-25T10:00:09.000Z',
      usage: USAGE
    })

    const rows = queryDailyUsage({})
    expect(rows).toHaveLength(1)
    expect(rows[0].runCount).toBe(1)
    expect(rows[0].stepCount).toBe(2)
    expect(rows[0].inputTokens).toBe(200)
    expect(rows[0].cacheReadTokens).toBe(80)
  })

  it('跨 UTC 午夜的 run 在两个日期各计一次', () => {
    const runId = seedRun({ startedAt: '2026-07-25T23:59:00.000Z' })
    startModelStep(stepDefaults(runId, 'call-1', '2026-07-25T23:59:01.000Z'))
    finishModelStep({
      runId,
      callId: 'call-1',
      status: 'complete',
      endedAt: '2026-07-25T23:59:30.000Z',
      usage: USAGE
    })
    startModelStep({
      ...stepDefaults(runId, 'call-2', '2026-07-26T00:00:10.000Z'),
      stepNumber: 1
    })
    finishModelStep({
      runId,
      callId: 'call-2',
      status: 'complete',
      endedAt: '2026-07-26T00:00:40.000Z',
      usage: USAGE
    })

    const rows = queryDailyUsage({}).sort((a, b) => a.date.localeCompare(b.date))
    expect(rows).toHaveLength(2)
    expect(rows[0].date).toBe('2026-07-25')
    expect(rows[1].date).toBe('2026-07-26')
    expect(rows[0].runCount).toBe(1)
    expect(rows[1].runCount).toBe(1)
  })

  it('无项目时维度键不重复:两个 run 落进同一日聚合行', () => {
    for (const runId of [seedRun({ messageId: 'a' }), seedRun({ messageId: 'b' })]) {
      startModelStep(stepDefaults(runId, `call-${runId}`))
      finishModelStep({
        runId,
        callId: `call-${runId}`,
        status: 'complete',
        endedAt: '2026-07-25T10:01:00.000Z',
        usage: USAGE
      })
    }
    const rows = queryDailyUsage({})
    expect(rows).toHaveLength(1)
    expect(rows[0].projectKey).toBe('none')
    expect(rows[0].runCount).toBe(2)
  })

  it('未上报字段不增加 reported_calls,也不用 0 冒充', () => {
    const runId = seedRun()
    startModelStep(stepDefaults(runId, 'call-1'))
    finishModelStep({
      runId,
      callId: 'call-1',
      status: 'complete',
      endedAt: '2026-07-25T10:00:05.000Z',
      usage: normalizeStepUsage({
        inputTokens: 10,
        inputTokenDetails: {
          noCacheTokens: undefined,
          cacheReadTokens: undefined,
          cacheWriteTokens: undefined
        },
        outputTokens: 5,
        outputTokenDetails: { textTokens: undefined, reasoningTokens: undefined },
        totalTokens: 15
      })
    })
    const [row] = queryDailyUsage({})
    expect(row.reportedInputCalls).toBe(1)
    expect(row.reportedCacheReadCalls).toBe(0)
    expect(row.reportedReasoningCalls).toBe(0)
    // 和数为 0 且 reported_calls 为 0 ⇒ 展示层显示"未报告"
    expect(row.cacheReadTokens).toBe(0)
  })
})

describe('step 状态机与幂等收尾', () => {
  it('请求发出即有 pending 行,错误/中止时行保留且 token 为 null', () => {
    const runId = seedRun()
    startModelStep(stepDefaults(runId, 'call-1'))

    let step = sqlite
      .prepare(`SELECT * FROM ai_run_steps WHERE call_id = 'call-1'`)
      .get() as Record<string, unknown>
    expect(step.status).toBe('pending')

    finishModelStep({
      runId,
      callId: 'call-1',
      status: 'error',
      endedAt: '2026-07-25T10:00:05.000Z',
      errorCode: 'UPSTREAM_ERROR',
      httpStatus: 500
    })
    step = sqlite.prepare(`SELECT * FROM ai_run_steps WHERE call_id = 'call-1'`).get() as Record<
      string,
      unknown
    >
    expect(step.status).toBe('error')
    expect(step.input_tokens).toBeNull()
    expect(step.error_code).toBe('UPSTREAM_ERROR')
    // 没有用量就没有聚合
    expect(queryDailyUsage({})).toHaveLength(0)
  })

  it('先 call-end 后 onStepEnd:用量恰好附加一次,重复收尾是 no-op', () => {
    const runId = seedRun()
    startModelStep(stepDefaults(runId, 'call-1'))
    // onLanguageModelCallEnd 先到,只有时间没有用量
    finishModelStep({
      runId,
      callId: 'call-1',
      status: 'complete',
      endedAt: '2026-07-25T10:00:05.000Z'
    })
    // onStepEnd 再到,补上用量
    finishModelStep({
      runId,
      callId: 'call-1',
      status: 'complete',
      endedAt: '2026-07-25T10:00:05.000Z',
      usage: USAGE
    })
    // 迟到的重复回调不得二次计数
    finishModelStep({
      runId,
      callId: 'call-1',
      status: 'complete',
      endedAt: '2026-07-25T10:00:06.000Z',
      usage: USAGE
    })

    const rows = queryDailyUsage({})
    expect(rows[0].stepCount).toBe(1)
    expect(rows[0].inputTokens).toBe(100)
  })

  it('step 更新、日 upsert、run-day 插入、run 汇总同事务回滚', () => {
    const runId = seedRun()
    startModelStep(stepDefaults(runId, 'call-1'))

    // 把日聚合表藏起来逼事务中途失败
    sqlite.exec('ALTER TABLE model_usage_daily RENAME TO model_usage_daily_hidden')
    expect(() =>
      finishModelStep({
        runId,
        callId: 'call-1',
        status: 'complete',
        endedAt: '2026-07-25T10:00:05.000Z',
        usage: USAGE
      })
    ).toThrow()
    sqlite.exec('ALTER TABLE model_usage_daily_hidden RENAME TO model_usage_daily')

    // step 必须还停在 pending,run 汇总没被污染,重试可成功且只记一次
    const step = sqlite
      .prepare(`SELECT * FROM ai_run_steps WHERE call_id = 'call-1'`)
      .get() as Record<string, unknown>
    expect(step.usage_state).toBe('pending')
    expect(sqlite.prepare(`SELECT count(*) n FROM model_usage_run_days`).get()).toEqual({ n: 0 })

    finishModelStep({
      runId,
      callId: 'call-1',
      status: 'complete',
      endedAt: '2026-07-25T10:00:05.000Z',
      usage: USAGE
    })
    expect(queryDailyUsage({})[0].inputTokens).toBe(100)
  })
})

describe('留存与清理', () => {
  function seedAggregatedRun(startedAt: string, messageId: string): string {
    const runId = seedRun({ startedAt, messageId })
    startModelStep(stepDefaults(runId, `call-${messageId}`, startedAt))
    finishModelStep({
      runId,
      callId: `call-${messageId}`,
      status: 'complete',
      endedAt: startedAt,
      usage: USAGE
    })
    startTool({
      runId,
      callId: `tool-${messageId}`,
      stepNumber: 0,
      toolName: 'write_file',
      inputStartedAt: startedAt
    })
    finishTool({ runId, callId: `tool-${messageId}`, status: 'success', at: startedAt })
    finishRun({ runId, status: 'complete', endedAt: startedAt })
    return runId
  }

  it('七天清理只删诊断与桥表,长期日聚合原样保留', () => {
    seedAggregatedRun('2026-07-10T08:00:00.000Z', 'old')
    seedAggregatedRun('2026-07-24T08:00:00.000Z', 'fresh')

    cleanupDiagnostics('2026-07-25T00:00:00.000Z')

    expect(sqlite.prepare(`SELECT count(*) n FROM ai_runs`).get()).toEqual({ n: 1 })
    expect(sqlite.prepare(`SELECT count(*) n FROM ai_run_steps`).get()).toEqual({ n: 1 })
    expect(sqlite.prepare(`SELECT count(*) n FROM tool_runs`).get()).toEqual({ n: 1 })
    expect(sqlite.prepare(`SELECT count(*) n FROM model_usage_run_days`).get()).toEqual({ n: 1 })
    // 两天的日聚合都还在
    expect(queryDailyUsage({})).toHaveLength(2)
  })

  it('清除长期用量同时清空日表与桥表', () => {
    seedAggregatedRun('2026-07-24T08:00:00.000Z', 'x')
    clearUsage()
    expect(queryDailyUsage({})).toHaveLength(0)
    expect(sqlite.prepare(`SELECT count(*) n FROM model_usage_run_days`).get()).toEqual({ n: 0 })
    // 诊断明细不受影响
    expect(sqlite.prepare(`SELECT count(*) n FROM ai_runs`).get()).toEqual({ n: 1 })
  })

  it('删项目级联删掉诊断三表,长期聚合与快照维度保留可查', () => {
    sqlite.prepare(`INSERT INTO projects (id, name) VALUES ('p1', '测试项目')`).run()
    const runId = seedRun({ projectId: 'p1' })
    startModelStep(stepDefaults(runId, 'call-1'))
    finishModelStep({
      runId,
      callId: 'call-1',
      status: 'complete',
      endedAt: '2026-07-25T10:00:05.000Z',
      usage: USAGE
    })
    startTool({
      runId,
      callId: 'tool-1',
      stepNumber: 0,
      toolName: 'write_file',
      inputStartedAt: '2026-07-25T10:00:06.000Z'
    })
    finishTool({ runId, callId: 'tool-1', status: 'success', at: '2026-07-25T10:00:07.000Z' })

    sqlite.prepare(`DELETE FROM projects WHERE id = 'p1'`).run()

    expect(sqlite.prepare(`SELECT count(*) n FROM ai_runs`).get()).toEqual({ n: 0 })
    expect(sqlite.prepare(`SELECT count(*) n FROM ai_run_steps`).get()).toEqual({ n: 0 })
    expect(sqlite.prepare(`SELECT count(*) n FROM tool_runs`).get()).toEqual({ n: 0 })

    const rows = queryDailyUsage({})
    expect(rows).toHaveLength(1)
    expect(rows[0].projectKey).toBe('project:p1')
    expect(rows[0].projectId).toBe('p1')
  })
})

describe('工具与 run 生命周期', () => {
  it('工具相位推进并以 run_id+call_id 幂等', () => {
    const runId = seedRun()
    startTool({
      runId,
      callId: 'tool-1',
      stepNumber: 0,
      toolName: 'apply_patch',
      inputStartedAt: '2026-07-25T10:00:01.000Z'
    })
    updateToolPhase({
      runId,
      callId: 'tool-1',
      phase: 'input_completed',
      at: '2026-07-25T10:00:02.000Z'
    })
    updateToolPhase({
      runId,
      callId: 'tool-1',
      phase: 'exec_started',
      at: '2026-07-25T10:00:02.100Z'
    })
    finishTool({
      runId,
      callId: 'tool-1',
      status: 'recoverable_error',
      at: '2026-07-25T10:00:02.500Z',
      errorCode: 'MATCH_NOT_FOUND',
      errorSummary: '旧文本不匹配',
      targetSummary: 'pages/index.vue',
      inputChars: 1200,
      outputChars: 80,
      affectedFileCount: 1
    })

    const row = sqlite.prepare(`SELECT * FROM tool_runs WHERE call_id = 'tool-1'`).get() as Record<
      string,
      unknown
    >
    expect(row.status).toBe('recoverable_error')
    expect(row.exec_started_at).toBe('2026-07-25T10:00:02.100Z')
    expect(row.error_code).toBe('MATCH_NOT_FOUND')
  })

  it('启动维护把遗留 running 标为 interrupted,诊断按消息可查', () => {
    const runId = seedRun()
    startModelStep(stepDefaults(runId, 'call-1'))
    markInterruptedRuns()

    const diag = getRunDiagnostics('m1')
    expect(diag?.run.status).toBe('interrupted')
    expect(diag?.steps).toHaveLength(1)
  })

  it('finishRun 记录终态与首次输出/首个文件时间', () => {
    const runId = seedRun()
    finishRun({
      runId,
      status: 'complete',
      endedAt: '2026-07-25T10:00:30.000Z',
      firstOutputAt: '2026-07-25T10:00:02.000Z',
      firstFileChangeAt: '2026-07-25T10:00:10.000Z',
      toolCallCount: 5,
      toolFailureCount: 1,
      tokenBreaker: true
    })
    const diag = getRunDiagnostics('m1')
    expect(diag?.run.status).toBe('complete')
    expect(diag?.run.firstFileChangeAt).toBe('2026-07-25T10:00:10.000Z')
    expect(diag?.run.toolCallCount).toBe(5)
    expect(diag?.run.tokenBreaker).toBe(true)
  })
})

describe('查询过滤', () => {
  it('按场景与 provider 过滤', () => {
    const runA = seedRun({ scene: 'design' })
    startModelStep(stepDefaults(runA, 'c1'))
    finishModelStep({
      runId: runA,
      callId: 'c1',
      status: 'complete',
      endedAt: '2026-07-25T10:00:05.000Z',
      usage: USAGE
    })
    const runB = seedRun({
      scene: 'provider_test',
      providerId: 'prov-2',
      providerSlug: 'anthropic'
    })
    startModelStep({ ...stepDefaults(runB, 'c2'), providerId: 'prov-2', providerSlug: 'anthropic' })
    finishModelStep({
      runId: runB,
      callId: 'c2',
      status: 'complete',
      endedAt: '2026-07-25T10:00:05.000Z',
      usage: USAGE
    })

    expect(queryDailyUsage({ scene: 'design' })).toHaveLength(1)
    expect(queryDailyUsage({ providerKey: 'prov-2' })).toHaveLength(1)
    expect(queryDailyUsage({ from: '2026-07-26' })).toHaveLength(0)
  })
})
