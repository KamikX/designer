import { and, eq, gte, lt, lte, sql } from 'drizzle-orm'
import { ulid } from 'ulid'
import type { DetailedUsage, UsageScene } from '../../../shared/types'
import { getDb } from '../index'
import { aiRuns, aiRunSteps, modelUsageDaily, modelUsageRunDays, toolRuns } from '../schema'
import type { AiRunRow, AiRunStepRow, ModelUsageDailyRow, ToolRunRow } from '../schema'

/**
 * AI 可观测性仓储。
 *
 * ## 为什么收尾必须是"run_id + call_id 幂等 + 状态机"
 *
 * onLanguageModelCallEnd 与 onStepEnd 都会到,顺序不保证,异常路径还可能
 * 只到一个。靠调用方"只调一次"是守不住的,双计一次就永久污染长期用量。
 * 所以行内带 usage_state(pending → ended_without_usage → aggregated),
 * 聚合只允许发生在非 aggregated 状态上,重复回调天然 no-op。
 *
 * ## 为什么时间戳全部由调用方传入
 *
 * RunTraceCollector 拿单调时钟算耗时、拿系统时钟出 ISO;仓储自己看表
 * 就没法测,也会让"step 归属哪一天"依赖执行时机而不是事件时机。
 */

interface StartRunInput {
  messageId?: string | null
  conversationId?: string | null
  projectId?: string | null
  providerId?: string | null
  providerSlug: string
  modelId: string
  scene: UsageScene
  startedAt: string
}

export function startRun(input: StartRunInput): string {
  const db = getDb()
  const row = db
    .insert(aiRuns)
    .values({
      messageId: input.messageId ?? null,
      conversationId: input.conversationId ?? null,
      projectId: input.projectId ?? null,
      providerId: input.providerId ?? null,
      providerSlug: input.providerSlug,
      modelId: input.modelId,
      scene: input.scene,
      status: 'running',
      startedAt: input.startedAt
    })
    .returning({ id: aiRuns.id })
    .get()
  return row.id
}

interface StartModelStepInput {
  runId: string
  callId: string
  stepNumber: number
  providerId?: string | null
  providerSlug: string
  modelId: string
  startedAt: string
}

/** 请求发出前插入 pending 行:provider 抛错、中止都不会让这次请求消失。 */
export function startModelStep(input: StartModelStepInput): void {
  const db = getDb()
  db.transaction((tx) => {
    tx.insert(aiRunSteps)
      .values({
        runId: input.runId,
        callId: input.callId,
        stepNumber: input.stepNumber,
        providerId: input.providerId ?? null,
        providerSlug: input.providerSlug,
        modelId: input.modelId,
        startedAt: input.startedAt,
        status: 'pending',
        usageState: 'pending'
      })
      .onConflictDoNothing()
      .run()
    tx.update(aiRuns)
      .set({
        modelCallCount: sql`${aiRuns.modelCallCount} + 1`,
        updatedAt: input.startedAt
      })
      .where(eq(aiRuns.id, input.runId))
      .run()
  })
}

interface FinishModelStepInput {
  runId: string
  callId: string
  status: 'complete' | 'error' | 'aborted'
  endedAt: string
  firstOutputAt?: string | null
  stepTimeMs?: number | null
  responseTimeMs?: number | null
  timeToFirstOutputMs?: number | null
  finishReason?: string | null
  httpStatus?: number | null
  errorCode?: string | null
  /** 有 usage 才聚合;没有只更新时间/状态,行保持对后续 enrichment 开放 */
  usage?: DetailedUsage | null
}

/** DetailedUsage 数值键 → 日聚合表的和数/上报次数列名对。 */
const USAGE_COLUMN_MAP = [
  ['inputTokens', 'input_tokens', 'reported_input_calls'],
  ['noCacheTokens', 'input_no_cache_tokens', 'reported_no_cache_calls'],
  ['cacheReadTokens', 'cache_read_tokens', 'reported_cache_read_calls'],
  ['cacheWriteTokens', 'cache_write_tokens', 'reported_cache_write_calls'],
  ['outputTokens', 'output_tokens', 'reported_output_calls'],
  ['textTokens', 'output_text_tokens', 'reported_text_calls'],
  ['reasoningTokens', 'reasoning_tokens', 'reported_reasoning_calls'],
  ['totalTokens', 'sdk_total_tokens', 'reported_sdk_total_calls'],
  ['providerTotalTokens', 'provider_total_tokens', 'reported_provider_total_calls']
] as const

export function finishModelStep(input: FinishModelStepInput): void {
  const db = getDb()
  db.transaction((tx) => {
    const step = tx
      .select()
      .from(aiRunSteps)
      .where(and(eq(aiRunSteps.runId, input.runId), eq(aiRunSteps.callId, input.callId)))
      .get()
    if (!step) return
    // aggregated 是终态:任何迟到/重复回调都不许再动这行或再计数
    if (step.usageState === 'aggregated') return

    const attachUsage = input.usage != null
    tx.update(aiRunSteps)
      .set({
        status: input.status,
        usageState: attachUsage ? 'aggregated' : 'ended_without_usage',
        endedAt: input.endedAt,
        firstOutputAt: input.firstOutputAt ?? step.firstOutputAt,
        stepTimeMs: input.stepTimeMs ?? step.stepTimeMs,
        responseTimeMs: input.responseTimeMs ?? step.responseTimeMs,
        timeToFirstOutputMs: input.timeToFirstOutputMs ?? step.timeToFirstOutputMs,
        finishReason: input.finishReason ?? step.finishReason,
        httpStatus: input.httpStatus ?? step.httpStatus,
        errorCode: input.errorCode ?? step.errorCode,
        ...(attachUsage
          ? {
              inputTokens: input.usage!.inputTokens,
              inputNoCacheTokens: input.usage!.noCacheTokens,
              cacheReadTokens: input.usage!.cacheReadTokens,
              cacheWriteTokens: input.usage!.cacheWriteTokens,
              outputTokens: input.usage!.outputTokens,
              outputTextTokens: input.usage!.textTokens,
              reasoningTokens: input.usage!.reasoningTokens,
              sdkTotalTokens: input.usage!.totalTokens,
              providerTotalTokens: input.usage!.providerTotalTokens,
              usageReported: JSON.stringify(input.usage!.reported)
            }
          : {}),
        updatedAt: input.endedAt
      })
      .where(eq(aiRunSteps.id, step.id))
      .run()

    if (!attachUsage) return
    const usage = input.usage!

    const run = tx.select().from(aiRuns).where(eq(aiRuns.id, input.runId)).get()
    if (!run) throw new Error(`ai_runs 行不存在: ${input.runId}`)

    // step 的 token 归它实际结束的 UTC 日期
    const utcDate = input.endedAt.slice(0, 10)
    const providerKey = step.providerId ?? `scene:${run.scene}`
    const projectKey = run.projectId ? `project:${run.projectId}` : 'none'
    const dims = {
      date: utcDate,
      providerKey,
      modelId: step.modelId,
      scene: run.scene as UsageScene,
      projectKey
    }

    // 只有真的插入桥表行,当日该维度的 run_count 才 +1(跨午夜各计一次)
    const inserted = tx
      .insert(modelUsageRunDays)
      .values({ runId: input.runId, ...dims })
      .onConflictDoNothing()
      .run()
    const runIncrement = inserted.changes > 0 ? 1 : 0

    // 未上报字段的贡献是 0/0:和数不动、reported_calls 不动
    const sums: Record<string, number> = {}
    for (const [usageKey, sumCol, reportedCol] of USAGE_COLUMN_MAP) {
      const value = usage[usageKey]
      sums[sumCol] = value ?? 0
      sums[reportedCol] = value != null ? 1 : 0
    }

    tx.run(sql`
      INSERT INTO model_usage_daily (
        id, date, provider_key, provider_id, provider_slug, model_id, scene,
        project_key, project_id, step_count, run_count,
        input_tokens, input_no_cache_tokens, cache_read_tokens, cache_write_tokens,
        output_tokens, output_text_tokens, reasoning_tokens, sdk_total_tokens,
        provider_total_tokens,
        reported_input_calls, reported_no_cache_calls, reported_cache_read_calls,
        reported_cache_write_calls, reported_output_calls, reported_text_calls,
        reported_reasoning_calls, reported_sdk_total_calls, reported_provider_total_calls,
        created_at, updated_at
      ) VALUES (
        ${cryptoRandomId()}, ${dims.date}, ${dims.providerKey}, ${step.providerId},
        ${step.providerSlug}, ${dims.modelId}, ${dims.scene},
        ${dims.projectKey}, ${run.projectId}, 1, ${runIncrement},
        ${sums.input_tokens}, ${sums.input_no_cache_tokens}, ${sums.cache_read_tokens},
        ${sums.cache_write_tokens}, ${sums.output_tokens}, ${sums.output_text_tokens},
        ${sums.reasoning_tokens}, ${sums.sdk_total_tokens}, ${sums.provider_total_tokens},
        ${sums.reported_input_calls}, ${sums.reported_no_cache_calls},
        ${sums.reported_cache_read_calls}, ${sums.reported_cache_write_calls},
        ${sums.reported_output_calls}, ${sums.reported_text_calls},
        ${sums.reported_reasoning_calls}, ${sums.reported_sdk_total_calls},
        ${sums.reported_provider_total_calls}, ${input.endedAt}, ${input.endedAt}
      )
      ON CONFLICT(date, provider_key, model_id, scene, project_key) DO UPDATE SET
        step_count = step_count + 1,
        run_count = run_count + ${runIncrement},
        input_tokens = input_tokens + ${sums.input_tokens},
        input_no_cache_tokens = input_no_cache_tokens + ${sums.input_no_cache_tokens},
        cache_read_tokens = cache_read_tokens + ${sums.cache_read_tokens},
        cache_write_tokens = cache_write_tokens + ${sums.cache_write_tokens},
        output_tokens = output_tokens + ${sums.output_tokens},
        output_text_tokens = output_text_tokens + ${sums.output_text_tokens},
        reasoning_tokens = reasoning_tokens + ${sums.reasoning_tokens},
        sdk_total_tokens = sdk_total_tokens + ${sums.sdk_total_tokens},
        provider_total_tokens = provider_total_tokens + ${sums.provider_total_tokens},
        reported_input_calls = reported_input_calls + ${sums.reported_input_calls},
        reported_no_cache_calls = reported_no_cache_calls + ${sums.reported_no_cache_calls},
        reported_cache_read_calls = reported_cache_read_calls + ${sums.reported_cache_read_calls},
        reported_cache_write_calls = reported_cache_write_calls + ${sums.reported_cache_write_calls},
        reported_output_calls = reported_output_calls + ${sums.reported_output_calls},
        reported_text_calls = reported_text_calls + ${sums.reported_text_calls},
        reported_reasoning_calls = reported_reasoning_calls + ${sums.reported_reasoning_calls},
        reported_sdk_total_calls = reported_sdk_total_calls + ${sums.reported_sdk_total_calls},
        reported_provider_total_calls = reported_provider_total_calls + ${sums.reported_provider_total_calls},
        updated_at = ${input.endedAt}
    `)

    // run 累计:未上报保持 null,报过就累加
    tx.update(aiRuns)
      .set({
        inputTokens:
          usage.inputTokens == null ? run.inputTokens : (run.inputTokens ?? 0) + usage.inputTokens,
        outputTokens:
          usage.outputTokens == null
            ? run.outputTokens
            : (run.outputTokens ?? 0) + usage.outputTokens,
        sdkTotalTokens:
          usage.totalTokens == null
            ? run.sdkTotalTokens
            : (run.sdkTotalTokens ?? 0) + usage.totalTokens,
        updatedAt: input.endedAt
      })
      .where(eq(aiRuns.id, input.runId))
      .run()
  })
}

/** 裸 SQL 插入拿不到 schema 的 $defaultFn,自己生成同风格 ULID */
function cryptoRandomId(): string {
  return ulid()
}

interface StartToolInput {
  runId: string
  callId: string
  stepNumber: number
  toolName: string
  inputStartedAt: string
}

export function startTool(input: StartToolInput): void {
  getDb()
    .insert(toolRuns)
    .values({
      runId: input.runId,
      callId: input.callId,
      stepNumber: input.stepNumber,
      toolName: input.toolName,
      inputStartedAt: input.inputStartedAt,
      status: 'running'
    })
    .onConflictDoNothing()
    .run()
}

interface UpdateToolPhaseInput {
  runId: string
  callId: string
  phase: 'input_completed' | 'exec_started'
  at: string
}

export function updateToolPhase(input: UpdateToolPhaseInput): void {
  getDb()
    .update(toolRuns)
    .set(
      input.phase === 'input_completed'
        ? { inputCompletedAt: input.at, updatedAt: input.at }
        : { execStartedAt: input.at, updatedAt: input.at }
    )
    .where(and(eq(toolRuns.runId, input.runId), eq(toolRuns.callId, input.callId)))
    .run()
}

interface FinishToolInput {
  runId: string
  callId: string
  status: 'success' | 'recoverable_error' | 'fatal_error' | 'aborted'
  at: string
  inputChars?: number | null
  outputChars?: number | null
  affectedFileCount?: number | null
  targetSummary?: string | null
  errorCode?: string | null
  errorSummary?: string | null
  recovered?: boolean
  breakerTripped?: boolean
}

export function finishTool(input: FinishToolInput): void {
  getDb()
    .update(toolRuns)
    .set({
      status: input.status,
      execCompletedAt: input.at,
      inputChars: input.inputChars ?? null,
      outputChars: input.outputChars ?? null,
      affectedFileCount: input.affectedFileCount ?? null,
      targetSummary: input.targetSummary ?? null,
      errorCode: input.errorCode ?? null,
      errorSummary: input.errorSummary ?? null,
      recovered: input.recovered ?? false,
      breakerTripped: input.breakerTripped ?? false,
      updatedAt: input.at
    })
    .where(and(eq(toolRuns.runId, input.runId), eq(toolRuns.callId, input.callId)))
    .run()
}

interface FinishRunInput {
  runId: string
  status: 'complete' | 'error' | 'aborted'
  endedAt: string
  firstOutputAt?: string | null
  firstFileChangeAt?: string | null
  toolCallCount?: number
  toolFailureCount?: number
  toolBreaker?: boolean
  tokenBreaker?: boolean
  errorBreaker?: boolean
}

export function finishRun(input: FinishRunInput): void {
  getDb()
    .update(aiRuns)
    .set({
      status: input.status,
      endedAt: input.endedAt,
      ...(input.firstOutputAt !== undefined ? { firstOutputAt: input.firstOutputAt } : {}),
      ...(input.firstFileChangeAt !== undefined
        ? { firstFileChangeAt: input.firstFileChangeAt }
        : {}),
      ...(input.toolCallCount !== undefined ? { toolCallCount: input.toolCallCount } : {}),
      ...(input.toolFailureCount !== undefined ? { toolFailureCount: input.toolFailureCount } : {}),
      ...(input.toolBreaker !== undefined ? { toolBreaker: input.toolBreaker } : {}),
      ...(input.tokenBreaker !== undefined ? { tokenBreaker: input.tokenBreaker } : {}),
      ...(input.errorBreaker !== undefined ? { errorBreaker: input.errorBreaker } : {}),
      updatedAt: input.endedAt
    })
    .where(eq(aiRuns.id, input.runId))
    .run()
}

/** 应用启动时调用:上次退出时没收尾的 run 一律标记 interrupted。 */
export function markInterruptedRuns(): void {
  getDb().update(aiRuns).set({ status: 'interrupted' }).where(eq(aiRuns.status, 'running')).run()
}

export interface RunDiagnosticsRecord {
  run: AiRunRow
  steps: AiRunStepRow[]
  tools: ToolRunRow[]
}

/** 按消息取最近一次 run 的完整诊断;7 天窗口外自然查不到。 */
export function getRunDiagnostics(messageId: string): RunDiagnosticsRecord | null {
  const db = getDb()
  const run = db
    .select()
    .from(aiRuns)
    .where(eq(aiRuns.messageId, messageId))
    .orderBy(sql`${aiRuns.startedAt} DESC`)
    .get()
  if (!run) return null
  const steps = db
    .select()
    .from(aiRunSteps)
    .where(eq(aiRunSteps.runId, run.id))
    .orderBy(aiRunSteps.stepNumber)
    .all()
  const tools = db
    .select()
    .from(toolRuns)
    .where(eq(toolRuns.runId, run.id))
    .orderBy(sql`${toolRuns.inputStartedAt}`)
    .all()
  return { run, steps, tools }
}

export interface DailyUsageQuery {
  /** YYYY-MM-DD,含端点 */
  from?: string
  to?: string
  providerKey?: string
  modelId?: string
  scene?: UsageScene
  projectKey?: string
}

export function queryDailyUsage(query: DailyUsageQuery): ModelUsageDailyRow[] {
  const conditions = [
    query.from ? gte(modelUsageDaily.date, query.from) : undefined,
    query.to ? lte(modelUsageDaily.date, query.to) : undefined,
    query.providerKey ? eq(modelUsageDaily.providerKey, query.providerKey) : undefined,
    query.modelId ? eq(modelUsageDaily.modelId, query.modelId) : undefined,
    query.scene ? eq(modelUsageDaily.scene, query.scene) : undefined,
    query.projectKey ? eq(modelUsageDaily.projectKey, query.projectKey) : undefined
  ].filter((c) => c !== undefined)

  return getDb()
    .select()
    .from(modelUsageDaily)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(sql`${modelUsageDaily.date} DESC`)
    .all()
}

const RETENTION_DAYS = 7

/**
 * 七天留存清理。只动诊断三表(经 ai_runs 级联)与去重桥表,
 * 长期日聚合永不在此删除。幂等,可在启动后与每轮结束后各触发一次。
 */
export function cleanupDiagnostics(now: string): void {
  const cutoffMs = Date.parse(now) - RETENTION_DAYS * 24 * 60 * 60 * 1000
  const cutoffIso = new Date(cutoffMs).toISOString()
  const cutoffDate = cutoffIso.slice(0, 10)
  const db = getDb()
  db.transaction((tx) => {
    tx.delete(aiRuns).where(lt(aiRuns.startedAt, cutoffIso)).run()
    tx.delete(modelUsageRunDays).where(lt(modelUsageRunDays.date, cutoffDate)).run()
  })
}

/** 用户手动清除长期用量:日表与桥表必须同事务清空,防止半清后 run_count 错乱。 */
export function clearUsage(): void {
  const db = getDb()
  db.transaction((tx) => {
    tx.delete(modelUsageDaily).run()
    tx.delete(modelUsageRunDays).run()
  })
}
