import type { Project } from '../../shared/types'
import type { MarkerStyleCommitResult } from './style-brief'
import { restoreMarkerStyleIfArtifactFailed } from './style-brief'

export type ChatFinalizeStatus = 'complete' | 'aborted' | 'error'

export interface ChatFinalizeResult {
  status: ChatFinalizeStatus
  usage: { inputTokens: number; outputTokens: number } | null
  artifactId: string | null
  error: unknown | null
}

export interface ChatFinalizeRequest<Artifact> {
  status: ChatFinalizeStatus
  usage: ChatFinalizeResult['usage']
  error?: unknown
  styleCommit: MarkerStyleCommitResult
  createArtifact?: () => Artifact | Promise<Artifact>
}

/**
 * 单回合唯一的收尾协调器。
 *
 * artifact 创建与 StyleBrief 补偿在消息落库之前完成；版本失败会直接转成
 * 一次 error settle。无论调用方之后是否因外层 catch 再次进入，版本创建、
 * 消息状态更新和结束事件都不会重放。
 */
export function createChatFinalizeCoordinator<Artifact>(input: {
  artifactId: (artifact: Artifact) => string
  restoreStyle: (styleBrief: string) => Project | null | Promise<Project | null>
  settle: (result: ChatFinalizeResult) => void | Promise<void>
  emitDone: (result: ChatFinalizeResult) => void
  emitError: (error: unknown, artifactId: string | null) => void
}): {
  finalize: (request: ChatFinalizeRequest<Artifact>) => Promise<ChatFinalizeResult>
} {
  let completed: ChatFinalizeResult | null = null
  let inFlight: Promise<ChatFinalizeResult> | null = null
  let artifactPhaseCompleted = false
  let artifactId: string | null = null
  let artifactFailed = false
  let artifactError: unknown | null = null

  const run = async (request: ChatFinalizeRequest<Artifact>): Promise<ChatFinalizeResult> => {
    // artifact 是回合级阶段，不属于某一次 settle 尝试。第一次进入后无论
    // 成功、失败或无需创建，后续错误收尾都只能复用该决定。
    if (!artifactPhaseCompleted) {
      artifactPhaseCompleted = true
      if (request.createArtifact) {
        try {
          const artifact = await request.createArtifact()
          artifactId = input.artifactId(artifact)
        } catch (createError) {
          artifactFailed = true
          artifactError = createError
          try {
            await restoreMarkerStyleIfArtifactFailed({
              commit: request.styleCommit,
              artifactCreated: false,
              restore: input.restoreStyle
            })
          } catch (restoreError) {
            artifactError = restoreError
          }
        }
      }
    }

    const result: ChatFinalizeResult = {
      status: artifactFailed ? 'error' : request.status,
      usage: artifactFailed ? null : request.usage,
      artifactId,
      // 重试 error settle 时使用第二次请求携带的外层错误；没有新错误时
      // 才回退到首次 artifact / 补偿错误。
      error: request.error ?? (artifactFailed ? artifactError : null)
    }

    await input.settle(result)
    if (result.status === 'error') input.emitError(result.error, result.artifactId)
    else input.emitDone(result)
    // 只有消息状态和对应事件都成功后，才把回合标为完成。
    completed = result
    return result
  }

  const finalize = (request: ChatFinalizeRequest<Artifact>): Promise<ChatFinalizeResult> => {
    if (completed) return Promise.resolve(completed)
    if (inFlight) return inFlight

    const current = run(request)
    inFlight = current
    void current.then(
      () => {
        if (inFlight === current) inFlight = null
      },
      () => {
        if (inFlight === current) inFlight = null
      }
    )
    return current
  }

  return { finalize }
}
