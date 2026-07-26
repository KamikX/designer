import { createHash } from 'node:crypto'
import type { DetailedUsage } from '../../shared/types'
import { AnchorRegistry } from './anchor-registry'
import type { ToolErrorCode } from './tool-result'
import { addDetailedUsage, emptyDetailedUsage } from './usage'

/**
 * 单回合的运行账本:修订号、锚点、失败、指纹、预算的内存事实。
 *
 * 只活在当前生成回合;长期指标由 SQLite 观测表保存。prepareStep 的一切
 * 程序化限制(不许重复调用、补丁降级、写入暂停)都以这里为准——
 * 不能只靠模型理解提示词文字。
 */

export interface WriteSummary {
  path: string
  revision: number
  tool: string
  chars: number
}

export interface ToolFailureSummary {
  tool: string
  code: ToolErrorCode
  path?: string
}

/** 连续写失败达到这个数就暂停写入,要求先重新定位/读取 */
const CONSECUTIVE_WRITE_FAILURE_LIMIT = 3
/** 同文件出现同一补丁错误码达到这个数,该文件禁用文本补丁 */
const SAME_PATCH_ERROR_LIMIT = 2

export class RunContextLedger {
  /** 锚点表跟回合同生共死,直接挂在账本上 */
  readonly anchors = new AnchorRegistry()
  readonly activatedSkills = new Set<string>()
  readonly completedWrites: WriteSummary[] = []
  readonly recentErrors: ToolFailureSummary[] = []
  cumulativeUsage: DetailedUsage = emptyDetailedUsage()
  toolCallCount = 0

  private fingerprints = new Set<string>()
  private consecutiveWriteFailures = 0
  /** 每个文件最近一次被读到的修订号,30 次阈值后的"禁止重读未变化文件"靠它 */
  private readRevisions = new Map<string, number>()
  /** path → code → 次数 */
  private patchErrorCounts = new Map<string, Map<string, number>>()
  private fatalReason: string | null = null

  /**
   * 指纹预留:同一(工具, 规范化参数, 目标修订)只许执行一次。
   * 修订参与哈希——文件变了以后同参数重调是合法的重新定位。
   * 只存哈希,完整参数永不落任何持久层。
   */
  tryReserveFingerprint(tool: string, input: unknown, revision: number | null): boolean {
    const key = createHash('sha256')
      .update(`${tool}\n${stableJson(input)}\n${revision ?? 'na'}`)
      .digest('hex')
    if (this.fingerprints.has(key)) return false
    this.fingerprints.add(key)
    return true
  }

  recordFailure(tool: string, code: ToolErrorCode, path?: string): void {
    this.recentErrors.push({ tool, code, ...(path ? { path } : {}) })
    this.consecutiveWriteFailures += 1
    if (path) {
      const perPath = this.patchErrorCounts.get(path) ?? new Map<string, number>()
      perPath.set(code, (perPath.get(code) ?? 0) + 1)
      this.patchErrorCounts.set(path, perPath)
    }
  }

  noteWriteSuccess(path: string, revision: number, tool: string, chars: number): void {
    this.consecutiveWriteFailures = 0
    this.completedWrites.push({ path, revision, tool, chars })
  }

  /** 一次成功的定位类操作(read/search/capture)解除"连续写失败"的暂停 */
  noteLocate(): void {
    this.consecutiveWriteFailures = 0
  }

  /** 记录"读过这个文件的这个修订" */
  noteRead(path: string, revision: number): void {
    this.readRevisions.set(path, revision)
  }

  hasReadAtRevision(path: string, revision: number): boolean {
    return this.readRevisions.get(path) === revision
  }

  /** 该文件是否已被禁用文本补丁(同错误码出现第二次) */
  textPatchDisabled(path: string): boolean {
    const perPath = this.patchErrorCounts.get(path)
    if (!perPath) return false
    for (const count of perPath.values()) {
      if (count >= SAME_PATCH_ERROR_LIMIT) return true
    }
    return false
  }

  writesPaused(): boolean {
    if (this.fatalReason) return true
    return this.consecutiveWriteFailures >= CONSECUTIVE_WRITE_FAILURE_LIMIT
  }

  /** SQLite / artifact / VFS 一致性错误:锁死写入,禁止产出新版本 */
  lockFatal(reason: string): void {
    this.fatalReason = reason
  }

  fatalLockReason(): string | null {
    return this.fatalReason
  }

  canFinalizeArtifact(): boolean {
    return this.fatalReason === null
  }

  addUsage(usage: DetailedUsage): void {
    this.cumulativeUsage = addDetailedUsage(this.cumulativeUsage, usage)
  }
}

/** 键排序后的稳定 JSON,让指纹对参数键序不敏感 */
function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      return Object.fromEntries(
        Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))
      )
    }
    return v
  })
}
