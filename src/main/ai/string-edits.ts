import { aiText } from '../i18n'
import MagicString from 'magic-string'
import type { AnchorRecord, AnchorRegistry } from './anchor-registry'
import type { SessionVfs } from './session-vfs'
import type { VfsPatch } from './session-vfs'

/**
 * MagicString 原子批量编辑器。
 *
 * ## 职责边界
 *
 * MagicString 只是保留格式的字符串编辑引擎:搜索、路径权限、revision、
 * 跨文件事务和错误恢复都在外面(AnchorRegistry / SessionVfs)。实例按次
 * 创建、用完即弃,不生成 sourcemap。
 *
 * ## 为什么"先规范化、再冲突检测、最后才调 MagicString"
 *
 * 业务语义(哪些区间冲突、插入怎么拼)必须由我们自己判定——依赖库抛错
 * 决定语义,等于把错误信息的质量和未来版本的行为都交给别人。MagicString
 * 在这里只做一件事:每个锚点恰好一次 update(start, end, composed)。
 * 全部坐标都是**原始坐标**,操作顺序天然不影响结果。
 */

export type StringEditOperation =
  | { type: 'replace'; anchorId: string; content: string }
  | { type: 'remove'; anchorId: string }
  | { type: 'insert_before'; anchorId: string; content: string }
  | { type: 'insert_after'; anchorId: string; content: string }

export type StringEditErrorCode = 'RANGE_OVERLAP' | 'INVALID_OPERATION'

export class StringEditError extends Error {
  constructor(
    public readonly code: StringEditErrorCode,
    message: string,
    /** 首个出问题的操作在请求数组里的下标,模型据此精确改参数 */
    public readonly operationIndex?: number
  ) {
    super(message)
    this.name = 'StringEditError'
  }
}

/** 同一锚点的全部操作合成一个"怎么改这段"的计划 */
interface AnchorPlan {
  anchor: AnchorRecord
  befores: string[]
  afters: string[]
  /** null = 保留原文(只有 insert);字符串 = replace/remove 后的核心内容 */
  core: string | null
  firstIndex: number
}

export interface AppliedStringEdit {
  path: string
  patch: VfsPatch
}

export class MagicStringBatchEditor {
  constructor(
    private readonly vfs: SessionVfs,
    private readonly registry: AnchorRegistry
  ) {}

  /**
   * 校验 → 计算 → 提交,三段式:
   * 1. 解析全部锚点(revision + hash),规范化并检测同文件区间冲突;
   * 2. 为每个文件算出最终字符串——这一步不碰 VFS;
   * 3. 所有文件都算成了才走 VFS 事务提交,并失效相关旧锚点。
   * 任何一步失败,内容、修订号、锚点表都保持原样。
   */
  apply(operations: StringEditOperation[]): AppliedStringEdit[] {
    if (operations.length === 0) {
      throw new StringEditError(
        'INVALID_OPERATION',
        aiText('ai.stringEdits.operationsCannotBeEmpty')
      )
    }

    // 1. 按锚点归组。before/after 保持请求数组顺序
    const plans = new Map<string, AnchorPlan>()
    for (const [index, op] of operations.entries()) {
      let plan = plans.get(op.anchorId)
      if (!plan) {
        const record = this.registry.get(op.anchorId)
        // 不存在的锚点让 resolve 抛统一的 ANCHOR_NOT_FOUND,不碰 VFS
        if (!record) this.registry.resolve(op.anchorId, -1, '')
        const anchor = this.registry.resolve(
          op.anchorId,
          this.vfs.revisionOf(record!.path) ?? -1,
          this.vfs.raw(record!.path).content
        )
        plan = { anchor, befores: [], afters: [], core: null, firstIndex: index }
        plans.set(op.anchorId, plan)
      }
      switch (op.type) {
        case 'insert_before':
          plan.befores.push(op.content)
          break
        case 'insert_after':
          plan.afters.push(op.content)
          break
        case 'replace':
        case 'remove': {
          if (plan.core !== null) {
            throw new StringEditError(
              'INVALID_OPERATION',
              aiText(
                'ai.stringEdits.anchorHasMultipleReplaceRemoveOperationsAtMostOneIsAllowedPer',
                op.anchorId
              ),
              index
            )
          }
          plan.core = op.type === 'replace' ? op.content : ''
          break
        }
      }
    }

    // 2. 按文件分组,冲突检测:排序后相邻允许共享边界,重叠一律拒绝
    const byPath = new Map<string, AnchorPlan[]>()
    for (const plan of plans.values()) {
      const list = byPath.get(plan.anchor.path) ?? []
      list.push(plan)
      byPath.set(plan.anchor.path, list)
    }
    for (const [path, list] of byPath) {
      list.sort((a, b) => a.anchor.startOffset - b.anchor.startOffset)
      for (let i = 1; i < list.length; i++) {
        const prev = list[i - 1].anchor
        const next = list[i].anchor
        if (next.startOffset < prev.endOffset) {
          throw new StringEditError(
            'RANGE_OVERLAP',
            aiText('ai.stringEdits.rangeInOverlapsWith', path, prev.startOffset, prev.endOffset) +
              aiText(
                'ai.stringEdits.splitThemIntoNonOverlappingAnchorsAndRetry',
                next.startOffset,
                next.endOffset
              ),
            list[i].firstIndex
          )
        }
      }
    }

    // 3. 先算全所有文件的产物
    const outputs = new Map<string, string>()
    for (const [path, list] of byPath) {
      const original = this.vfs.raw(path).content
      const magic = new MagicString(original)
      for (const plan of list) {
        const { startOffset, endOffset } = plan.anchor
        const core = plan.core ?? original.slice(startOffset, endOffset)
        const composed = plan.befores.join('') + core + plan.afters.join('')
        // 每个锚点恰好一次 update:不用 prependLeft/appendRight,相邻 remove
        // 也不会吞掉本属于邻居的插入
        if (composed === '') magic.remove(startOffset, endOffset)
        else magic.update(startOffset, endOffset, composed)
      }
      outputs.set(path, magic.toString())
    }

    // 4. 全部成功才提交;VFS 事务保证半路失败(如写入闸门)整体回滚
    const applied: AppliedStringEdit[] = []
    this.vfs.transact(() => {
      for (const [path, content] of outputs) {
        applied.push({ path, patch: this.vfs.write(path, content) })
      }
    })
    // 提交成了,旧修订的锚点全部失效——它们的坐标已经没有意义
    for (const path of outputs.keys()) {
      this.registry.invalidatePath(path, this.vfs.revisionOf(path) ?? -1)
    }
    return applied
  }
}
