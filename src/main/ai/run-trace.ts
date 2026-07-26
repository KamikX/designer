import type { LanguageModelUsage } from 'ai'
import type { AdapterType, UsageScene } from '../../shared/types'
import * as observability from '../db/repo/ai-observability'
import { redactTraceText, sanitizeToolTrace } from './tool-trace-sanitizer'
import { normalizeStepUsage } from './usage'

/**
 * 运行追踪采集器:把一次语言模型 run 的生命周期回调翻译成仓储调用。
 *
 * ## 职责边界
 *
 * 采集器只做三件事:维护 run/step/tool 的内存状态、用注入的时钟算耗时、
 * 在正确的时机调仓储。它**不改变生成行为**——任何仓储错误都被吞掉并
 * 打日志,绝不允许"记账失败"打断用户正在进行的生成。
 *
 * ## 为什么时钟必须注入
 *
 * 耗时用单调钟(系统时间跳变不影响 stepTimeMs),落库时间用墙上钟。
 * 两者都从构造参数来,测试才能用假时钟验证毫秒级语义。
 */

export interface TraceClock {
  nowIso(): string
  monoMs(): number
}

/** 仓储面。生产用 db/repo/ai-observability,测试注入假实现 */
export interface RunTraceRepo {
  startRun: typeof observability.startRun
  startModelStep: typeof observability.startModelStep
  finishModelStep: typeof observability.finishModelStep
  startTool: typeof observability.startTool
  updateToolPhase: typeof observability.updateToolPhase
  finishTool: typeof observability.finishTool
  finishRun: typeof observability.finishRun
}

interface CollectorOptions {
  scene: UsageScene
  messageId?: string | null
  conversationId?: string | null
  projectId?: string | null
  providerId?: string | null
  providerSlug: string
  modelId: string
  /** 用于从 usage.raw 白名单提取 provider 原始总量 */
  adapter?: AdapterType
  repo?: RunTraceRepo
  clock?: TraceClock
}

interface StepState {
  monoStart: number
  stepNumber: number
  firstOutputMono: number | null
  closed: boolean
}

interface ToolState {
  toolName: string
  mcp: boolean
  stepNumber: number
  targetSummary: string | null
  inputChars: number | null
  closed: boolean
}

const defaultClock: TraceClock = {
  nowIso: () => new Date().toISOString(),
  monoMs: () => performance.now()
}

type ToolTerminalStatus = 'success' | 'recoverable_error' | 'fatal_error' | 'aborted'

export class RunTraceCollector {
  private readonly opts: CollectorOptions
  private readonly repo: RunTraceRepo
  private readonly clock: TraceClock
  private runId: string | null = null
  private stepCounter = 0
  private steps = new Map<string, StepState>()
  private tools = new Map<string, ToolState>()
  private toolCallCount = 0
  private toolFailureCount = 0
  private firstOutputAt: string | null = null
  private firstFileChangeAt: string | null = null
  private breakers = { tool: false, token: false, error: false }
  private finished = false

  constructor(opts: CollectorOptions) {
    this.opts = opts
    this.repo = opts.repo ?? observability
    this.clock = opts.clock ?? defaultClock
  }

  /** 仓储失败只打日志:遥测永远不许弄死正在跑的生成 */
  private safe(action: () => void): void {
    try {
      action()
    } catch (err) {
      console.warn('[run-trace] 仓储写入失败:', err instanceof Error ? err.message : err)
    }
  }

  start(): void {
    this.safe(() => {
      this.runId = this.repo.startRun({
        messageId: this.opts.messageId ?? null,
        conversationId: this.opts.conversationId ?? null,
        projectId: this.opts.projectId ?? null,
        providerId: this.opts.providerId ?? null,
        providerSlug: this.opts.providerSlug,
        modelId: this.opts.modelId,
        scene: this.opts.scene,
        startedAt: this.clock.nowIso()
      })
    })
  }

  modelCallStart(callId: string, snapshot?: { providerSlug?: string; modelId?: string }): void {
    if (!this.runId || this.steps.has(callId)) return
    const stepNumber = this.stepCounter++
    this.steps.set(callId, {
      monoStart: this.clock.monoMs(),
      stepNumber,
      firstOutputMono: null,
      closed: false
    })
    this.safe(() =>
      this.repo.startModelStep({
        runId: this.runId!,
        callId,
        stepNumber,
        providerId: this.opts.providerId ?? null,
        providerSlug: snapshot?.providerSlug ?? this.opts.providerSlug,
        modelId: snapshot?.modelId ?? this.opts.modelId,
        startedAt: this.clock.nowIso()
      })
    )
  }

  /** 首个可见输出。run 级只记第一次;step 级记当前未收尾 step 的首包 */
  markFirstOutput(): void {
    if (!this.firstOutputAt) this.firstOutputAt = this.clock.nowIso()
    const mono = this.clock.monoMs()
    for (const step of this.steps.values()) {
      if (!step.closed && step.firstOutputMono == null) step.firstOutputMono = mono
    }
  }

  /** 首个文件变化(file-patch/file-start),用户第一次看到产物动了 */
  markFirstFilePatch(): void {
    if (!this.firstFileChangeAt) this.firstFileChangeAt = this.clock.nowIso()
  }

  /** onLanguageModelCallEnd / 请求抛错 / 中止:没有 usage 的收尾 */
  modelCallEnd(
    callId: string,
    outcome: {
      status: 'complete' | 'error' | 'aborted'
      finishReason?: string | null
      httpStatus?: number | null
      errorCode?: string | null
    }
  ): void {
    const step = this.steps.get(callId)
    if (!this.runId || !step) return
    const mono = this.clock.monoMs()
    if (outcome.status !== 'complete') step.closed = true
    this.safe(() =>
      this.repo.finishModelStep({
        runId: this.runId!,
        callId,
        status: outcome.status,
        endedAt: this.clock.nowIso(),
        stepTimeMs: Math.round(mono - step.monoStart),
        timeToFirstOutputMs:
          step.firstOutputMono == null ? null : Math.round(step.firstOutputMono - step.monoStart),
        finishReason: outcome.finishReason ?? null,
        httpStatus: outcome.httpStatus ?? null,
        errorCode: outcome.errorCode ?? null
      })
    )
  }

  /**
   * onLanguageModelCallEnd / onStepEnd:带 usage 的最终收尾。
   * 聚合恰好发生一次(仓储状态机保证)。SDK 上报的 performance 优先,
   * 采集器自己的单调钟只做缺省兜底。
   */
  stepEnd(
    callId: string,
    usage: LanguageModelUsage | undefined,
    opts?: {
      finishReason?: string | null
      responseTimeMs?: number | null
      timeToFirstOutputMs?: number | null
    }
  ): void {
    const step = this.steps.get(callId)
    if (!this.runId || !step) return
    const mono = this.clock.monoMs()
    step.closed = true
    const localFirstOutputMs =
      step.firstOutputMono == null ? null : Math.round(step.firstOutputMono - step.monoStart)
    this.safe(() =>
      this.repo.finishModelStep({
        runId: this.runId!,
        callId,
        status: 'complete',
        endedAt: this.clock.nowIso(),
        stepTimeMs: Math.round(mono - step.monoStart),
        responseTimeMs: opts?.responseTimeMs ?? null,
        timeToFirstOutputMs: opts?.timeToFirstOutputMs ?? localFirstOutputMs,
        finishReason: opts?.finishReason ?? null,
        usage: normalizeStepUsage(usage, { adapter: this.opts.adapter })
      })
    )
  }

  toolInputStart(callId: string, toolName: string, opts?: { mcp?: boolean }): void {
    if (!this.runId || this.tools.has(callId)) return
    this.toolCallCount++
    const stepNumber = Math.max(0, this.stepCounter - 1)
    this.tools.set(callId, {
      toolName,
      mcp: opts?.mcp ?? false,
      stepNumber,
      targetSummary: null,
      inputChars: null,
      closed: false
    })
    this.safe(() =>
      this.repo.startTool({
        runId: this.runId!,
        callId,
        stepNumber,
        toolName,
        inputStartedAt: this.clock.nowIso()
      })
    )
  }

  /** tool-call:入参齐了。在这里做白名单脱敏——原始入参只在本调用栈存在 */
  toolInputEnd(callId: string, input: unknown, inputChars?: number | null): void {
    const tool = this.tools.get(callId)
    if (!this.runId || !tool) return
    tool.targetSummary = sanitizeToolTrace(tool.toolName, input, { mcp: tool.mcp }).targetSummary
    tool.inputChars = inputChars ?? null
    this.safe(() =>
      this.repo.updateToolPhase({
        runId: this.runId!,
        callId,
        phase: 'input_completed',
        at: this.clock.nowIso()
      })
    )
  }

  toolExecutionStart(callId: string): void {
    if (!this.runId || !this.tools.has(callId)) return
    this.safe(() =>
      this.repo.updateToolPhase({
        runId: this.runId!,
        callId,
        phase: 'exec_started',
        at: this.clock.nowIso()
      })
    )
  }

  toolExecutionEnd(
    callId: string,
    result: {
      status: ToolTerminalStatus
      outputChars?: number | null
      affectedFileCount?: number | null
      errorCode?: string | null
      errorSummary?: string | null
      recovered?: boolean
      breakerTripped?: boolean
    }
  ): void {
    const tool = this.tools.get(callId)
    if (!this.runId || !tool || tool.closed) return
    tool.closed = true
    if (result.status === 'recoverable_error' || result.status === 'fatal_error') {
      this.toolFailureCount++
    }
    this.safe(() =>
      this.repo.finishTool({
        runId: this.runId!,
        callId,
        status: result.status,
        at: this.clock.nowIso(),
        inputChars: tool.inputChars,
        outputChars: result.outputChars ?? null,
        affectedFileCount: result.affectedFileCount ?? null,
        targetSummary: tool.targetSummary,
        errorCode: result.errorCode ?? null,
        errorSummary: result.errorSummary ? redactTraceText(result.errorSummary) : null,
        recovered: result.recovered ?? false,
        breakerTripped: result.breakerTripped ?? false
      })
    )
  }

  setBreaker(kind: 'tool' | 'token' | 'error'): void {
    this.breakers[kind] = true
  }

  /**
   * run 收尾。幂等;必须放 finally 里调。
   * 未收尾的工具/step 一并按 run 终态关闭——中止时它们就是被中止的。
   */
  finish(status: 'complete' | 'error' | 'aborted'): void {
    if (!this.runId || this.finished) return
    this.finished = true

    const danglingStatus: ToolTerminalStatus = status === 'aborted' ? 'aborted' : 'fatal_error'
    for (const [callId, tool] of this.tools) {
      if (!tool.closed) {
        this.toolExecutionEnd(callId, {
          status: status === 'complete' ? 'aborted' : danglingStatus
        })
      }
    }
    for (const [callId, step] of this.steps) {
      if (!step.closed) {
        this.modelCallEnd(callId, {
          status: status === 'complete' ? 'complete' : status
        })
      }
    }

    this.safe(() =>
      this.repo.finishRun({
        runId: this.runId!,
        status,
        endedAt: this.clock.nowIso(),
        firstOutputAt: this.firstOutputAt,
        firstFileChangeAt: this.firstFileChangeAt,
        toolCallCount: this.toolCallCount,
        toolFailureCount: this.toolFailureCount,
        toolBreaker: this.breakers.tool,
        tokenBreaker: this.breakers.token,
        errorBreaker: this.breakers.error
      })
    )
  }
}
