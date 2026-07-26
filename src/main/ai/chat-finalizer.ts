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
  let settled: ChatFinalizeResult | null = null

  return {
    finalize: async (request) => {
      if (settled) return settled

      let status = request.status
      let usage = request.usage
      let artifactId: string | null = null
      let error: unknown | null = request.error ?? null

      if (request.createArtifact) {
        try {
          const artifact = await request.createArtifact()
          artifactId = input.artifactId(artifact)
        } catch (artifactError) {
          try {
            await restoreMarkerStyleIfArtifactFailed({
              commit: request.styleCommit,
              artifactCreated: false,
              restore: input.restoreStyle
            })
          } catch (restoreError) {
            error = restoreError
          }
          status = 'error'
          usage = null
          error ??= artifactError
        }
      }

      settled = { status, usage, artifactId, error }
      await input.settle(settled)
      if (status === 'error') input.emitError(error, artifactId)
      else input.emitDone(settled)
      return settled
    }
  }
}
