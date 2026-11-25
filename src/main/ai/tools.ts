import { localizedTools } from '../i18n'
import { aiText } from '../i18n'
import { promptText } from './prompts/i18n'
import type { PromptLanguage } from './prompts/i18n'
import { tool } from 'ai'
import type { ToolSet } from 'ai'
import { z } from 'zod'
import { AnchorError } from './anchor-registry'
import { RunContextLedger } from './run-context-ledger'
import { SessionVfs } from './session-vfs'
import type { SearchHit, VfsPatch } from './session-vfs'
import { MagicStringBatchEditor, StringEditError } from './string-edits'
import type { StringEditOperation } from './string-edits'
import {
  ANCHORED_EDIT_RECOVERY,
  classifyError,
  renderToolResult,
  toolError,
  toolOk
} from './tool-result'
import type { ToolResult } from './tool-result'
import { VfsError } from './vfs-error'
import { parsePatch } from './patch-format'
import { unifiedDiff } from './text-diff'
import { checkSyntax } from './text-syntax'
import { compileProbe } from './compile-probe'

/**
 * 给模型的文件工具集,分工照 VS Code agent 那套(readFile / textSearch /
 * fileSearch / listDirectory / editFiles / changes)裁剪到设计稿这个场景。
 *
 * ## 四条设计原则
 *
 * 1. **用锚点定位,不用行号。** 行号在连续编辑中会漂移。文本锚点
 *    (old_string)之上又有一层服务端锚点(capture_range / matchId +
 *    apply_string_edits):区间由主进程持有,模型不再复述原文——超长行、
 *    被截断的行、第一次补丁失败后,一律切到锚点编辑。
 *
 * 2. **能搜就别读,能读一段就别读整份。** search_files 直接给命中行和
 *    matchId,outline_file 给骨架,read_file 有硬上限。
 *
 * 3. **能一次改完就别分多次。** 同一文件多处用 multi_edit_file,跨文件用
 *    apply_patch / apply_string_edits。步数本身就是 token。
 *
 * 4. **错误是带码的结果文本,不是异常。** 抛异常会中断 streamText 循环;
 *    结构化错误(code + 恢复动作)渲染成文本返回,模型据此自我纠正,
 *    RunContextLedger 据此做熔断:重复指纹拒绝、同错误两次禁用文本补丁、
 *    连续三次写失败暂停写入。
 */

/** 单个工具结果的字符上限:结果会随每一步重发,放任下去等于持续漏 token */
const MAX_RESULT_CHARS = 12000

function capped(text: string): string {
  if (text.length <= MAX_RESULT_CHARS) return text
  return aiText(
    'ai.tools.resultTruncatedCharactersNarrowTheRangeAndTryAgain',
    text.slice(0, MAX_RESULT_CHARS),
    text.length
  )
}

export interface FileToolSink {
  /** 文件被写入 / 局部编辑 */
  onPatch: (patch: VfsPatch) => void
  /** 文件被删除 */
  onDelete: (path: string) => void
}

export interface FileToolOptions {
  /** 回合账本。不传则各自新建(测试/纯编辑场景) */
  ledger?: RunContextLedger
  /**
   * 读闸门(ContextGovernor 提供):30 次调用后禁止重读未变化的文件。
   * 返回拒绝文案表示拦下,null 放行。
   */
  readGate?: (path: string, revision: number) => string | null
}

function renderHits(hits: (SearchHit & { matchId?: string })[], withContext: boolean): string {
  if (hits.length === 0) return aiText('ai.tools.noMatchesBroadenTheQueryOrUseListFilesToCheckThe')
  const truncated = hits.some((hit) => hit.text.length >= 800)
  const blocks = hits.map((hit) => {
    const id = hit.matchId ? ` [matchId: ${hit.matchId}]` : ''
    const head = `${hit.path}:${hit.line}:${hit.column}${id}`
    if (!withContext) return `${head}: ${hit.text}`
    const before = hit.before.map((l, i) => `  ${hit.line - hit.before.length + i}  ${l}`)
    const after = hit.after.map((l, i) => `  ${hit.line + 1 + i}  ${l}`)
    return [head, ...before, `> ${hit.line}  ${hit.text}`, ...after].join('\n')
  })
  const note = truncated
    ? aiText('ai.tools.notePreviewLinesAreTruncatedDoNotCopyPreviewsIntoOldString')
    : ''
  return aiText('ai.tools.matches', hits.length, blocks.join(withContext ? '\n\n' : '\n'), note)
}

/** 工具按职责分类,写入闸门与补丁降级只对相应类别生效 */
type ToolKind = 'read' | 'locate' | 'textPatch' | 'write' | 'neutral'

export function buildFileTools(
  vfs: SessionVfs,
  sink: FileToolSink,
  options: FileToolOptions = {},
  lang: PromptLanguage = 'zh-CN'
): ToolSet {
  const emitPatch = sink.onPatch
  const ledger = options.ledger ?? new RunContextLedger()
  const registry = ledger.anchors
  const editor = new MagicStringBatchEditor(vfs, registry)

  /** 无 path 的工具用全 VFS 修订摘要做指纹的一部分,改动后即可重调 */
  const revisionDigest = (): number =>
    vfs.list().reduce((sum, path) => sum + (vfs.revisionOf(path) ?? 0), 0)

  /**
   * 统一执行壳:指纹 → 闸门 → 执行 → 记账 → 渲染。
   * 任何 VfsError/AnchorError/StringEditError 都变成带码结果;
   * 其他异常照抛——那是程序缺陷,不该被模型"自我纠正"掩埋。
   */
  const run = (
    name: string,
    kind: ToolKind,
    input: unknown,
    path: string | null,
    body: () => ToolResult
  ): string => {
    if (kind === 'textPatch' || kind === 'write') {
      const fatal = ledger.fatalLockReason()
      if (fatal) {
        return renderToolResult(
          toolError(
            'TOOL_EXECUTION_FAILED',
            aiText('ai.tools.writingIsLockedFilesCannotBeChangedInThisTurn', fatal)
          )
        )
      }
      if (ledger.writesPaused()) {
        return renderToolResult(
          toolError(
            'TOOL_EXECUTION_FAILED',
            aiText('ai.tools.writingPausedAfter3ConsecutiveFailuresLocateTheTargetAgainWithSearch')
          )
        )
      }
      if (kind === 'textPatch' && path && ledger.textPatchDisabled(path)) {
        return renderToolResult(
          toolError(
            'MATCH_NOT_FOUND',
            aiText('ai.tools.textPatchesForHaveFailedTwiceInThisTurnFurtherTextPatches', path),
            ANCHORED_EDIT_RECOVERY
          )
        )
      }
    }
    // 指纹放在闸门之后:被闸门挡下的调用没执行过,解除后原参数应当能再试。
    // 非法路径连修订号都取不到:按 -1 参与指纹,让真正的报错发生在执行体里
    let revision: number
    try {
      revision = path !== null ? (vfs.revisionOf(path) ?? revisionDigest()) : revisionDigest()
    } catch {
      revision = -1
    }
    if (!ledger.tryReserveFingerprint(name, input, revision)) {
      return renderToolResult(
        toolError(
          'TOOL_EXECUTION_FAILED',
          aiText('ai.tools.duplicateCallJustRanWithTheSameArgumentsAndTheTargetHas', name)
        )
      )
    }
    // 30 次阈值后的"禁止重读未变化文件":程序化闸门,不赌模型自觉
    if ((kind === 'read' || kind === 'locate') && path !== null && options.readGate) {
      const denied = options.readGate(path, revision)
      if (denied) return renderToolResult(toolError('TOOL_EXECUTION_FAILED', denied))
    }
    try {
      const result = body()
      if (kind === 'read' || kind === 'locate') {
        ledger.noteLocate()
        if (path !== null) ledger.noteRead(path, revision)
      }
      // 写入成功后立刻真编译:错误随工具结果当轮回喂,而不是等预览白屏、
      // 下一个用户回合才知道。改动保留——以坏版本为基线修,好过让十步工作蒸发
      if (result.ok && (kind === 'write' || kind === 'textPatch')) {
        const touched = result.affectedFiles ?? (path !== null ? [path] : [])
        const failures = touched.flatMap((p) => {
          let content: string
          try {
            content = vfs.raw(p).content
          } catch {
            return [] // 删除/移动后原路径已不存在,没有可编译的内容
          }
          const error = compileProbe(p, content)
          return error ? [`- ${p}:${error}`] : []
        })
        if (failures.length) {
          result.message +=
            aiText('ai.tools.warningChangesWereSavedButTheseFilesFailCompilationAndLeaveThe') +
            failures.join('\n')
        }
      }
      return capped(renderToolResult(result))
    } catch (err) {
      if (
        !(err instanceof VfsError) &&
        !(err instanceof AnchorError) &&
        !(err instanceof StringEditError)
      ) {
        // 非预期异常是程序缺陷或本地一致性坏了:锁死后续写入并禁止产出
        // 新版本——带着未知状态继续写,只会让 artifact 与 VFS 不一致
        ledger.lockFatal(aiText('ai.tools.unexpectedErrorInTool', name))
        throw err
      }
      const result = classifyError(err)
      ledger.recordFailure(name, result.code ?? 'TOOL_EXECUTION_FAILED', path ?? undefined)
      return renderToolResult(result)
    }
  }

  // 先建再返回,不要直接 return 字面量:ToolSet 会反过来上下文推断,
  // 把每个 tool 的 INPUT 泛型压成 never,inputSchema 就对不上了
  const tools = {
    /* -------------------------------- 读 -------------------------------- */

    list_files: tool({
      description: promptText(lang, 'tools.list_files.description'),
      inputSchema: z.object({
        glob: z.string().optional().describe(promptText(lang, 'tools.list_files.parameters.glob'))
      }),
      // 参数不解构:schema 带可选字段时,解构模式会参与 INPUT 泛型推断
      // 并把它压成 never,inputSchema 随即报类型不匹配
      execute: async (input) =>
        run('list_files', 'read', input, null, () => {
          const stats = vfs.stats(input.glob)
          if (stats.length === 0) {
            return toolOk(
              input.glob
                ? aiText('ai.localTools.noFilesMatch', input.glob)
                : aiText('ai.tools.theDesignHasNoFilesYet')
            )
          }
          return toolOk(stats.map((s) => aiText('ai.tools.lines', s.path, s.lines)).join('\n'))
        })
    }),

    outline_file: tool({
      description: promptText(lang, 'tools.outline_file.description'),
      inputSchema: z.object({ path: z.string() }),
      execute: async (input) =>
        run('outline_file', 'read', input, input.path, () => toolOk(vfs.outline(input.path)))
    }),

    read_file: tool({
      description: promptText(lang, 'tools.read_file.description'),
      inputSchema: z.object({
        path: z.string().describe(promptText(lang, 'tools.read_file.parameters.path')),
        start_line: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe(promptText(lang, 'tools.read_file.parameters.start_line')),
        end_line: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe(promptText(lang, 'tools.read_file.parameters.end_line'))
      }),
      execute: async (input) =>
        run('read_file', 'read', input, input.path, () =>
          toolOk(vfs.read(input.path, input.start_line, input.end_line))
        )
    }),

    get_range: tool({
      description: promptText(lang, 'tools.get_range.description'),
      inputSchema: z.object({
        path: z.string(),
        start_line: z
          .number()
          .int()
          .min(1)
          .describe(promptText(lang, 'tools.get_range.parameters.start_line')),
        end_line: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe(promptText(lang, 'tools.get_range.parameters.end_line')),
        start_column: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe(promptText(lang, 'tools.get_range.parameters.start_column')),
        end_column: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe(promptText(lang, 'tools.get_range.parameters.end_column'))
      }),
      execute: async (input) =>
        run('get_range', 'locate', input, input.path, () =>
          toolOk(
            vfs.getRange(
              input.path,
              input.start_line,
              input.end_line,
              input.start_column,
              input.end_column
            )
          )
        )
    }),

    capture_range: tool({
      description: promptText(lang, 'tools.capture_range.description'),
      inputSchema: z.object({
        path: z.string(),
        start_line: z
          .number()
          .int()
          .min(1)
          .describe(promptText(lang, 'tools.capture_range.parameters.start_line')),
        end_line: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe(promptText(lang, 'tools.capture_range.parameters.end_line')),
        start_column: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe(promptText(lang, 'tools.capture_range.parameters.start_column')),
        end_column: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe(promptText(lang, 'tools.capture_range.parameters.end_column')),
        include_trailing_newline: z
          .boolean()
          .optional()
          .describe(promptText(lang, 'tools.capture_range.parameters.include_trailing_newline'))
      }),
      execute: async (input) =>
        run('capture_range', 'locate', input, input.path, () => {
          const revision = vfs.revisionOf(input.path)
          if (revision === null)
            throw new VfsError(aiText('ai.tools.fileDoesNotExist', input.path), 'FILE_NOT_FOUND')
          const { anchor, text } = registry.capture(
            input.path,
            revision,
            vfs.raw(input.path).content,
            {
              startLine: input.start_line,
              endLine: input.end_line,
              startColumn: input.start_column,
              endColumn: input.end_column,
              includeTrailingNewline: input.include_trailing_newline
            }
          )
          // 正文精确不截断:锚点的意义就是让模型不必复述,想核对时必须可信
          return toolOk(`anchorId: ${anchor.id}\n----\n${text}`)
        })
    }),

    search_files: tool({
      description: promptText(lang, 'tools.search_files.description'),
      inputSchema: z.object({
        query: z.string().describe(promptText(lang, 'tools.search_files.parameters.query')),
        is_regex: z
          .boolean()
          .optional()
          .describe(promptText(lang, 'tools.search_files.parameters.is_regex')),
        glob: z
          .string()
          .optional()
          .describe(promptText(lang, 'tools.search_files.parameters.glob')),
        context_lines: z
          .number()
          .int()
          .min(0)
          .max(5)
          .optional()
          .describe(promptText(lang, 'tools.search_files.parameters.context_lines')),
        case_sensitive: z
          .boolean()
          .optional()
          .describe(promptText(lang, 'tools.search_files.parameters.case_sensitive')),
        max_results: z.number().int().min(1).max(60).optional()
      }),
      execute: async (input) =>
        run('search_files', 'locate', input, null, () => {
          const hits = vfs.search(input.query, {
            regex: input.is_regex,
            glob: input.glob,
            contextLines: input.context_lines,
            caseSensitive: input.case_sensitive,
            maxResults: input.max_results
          })
          // 每个命中登记完整内部匹配为锚点:预览可以截断,锚点不会
          const withIds = hits.map((hit) => {
            if (!hit.matchLength) return hit
            try {
              const revision = vfs.revisionOf(hit.path)
              if (revision === null) return hit
              const { anchor } = registry.capture(hit.path, revision, vfs.raw(hit.path).content, {
                startLine: hit.line,
                startColumn: hit.column,
                endColumn: hit.column + hit.matchLength - 1
              })
              return { ...hit, matchId: anchor.id }
            } catch {
              // 个别命中登记失败(如切进代理对)不拖垮整次搜索
              return hit
            }
          })
          return toolOk(renderHits(withIds, (input.context_lines ?? 0) > 0))
        })
    }),

    /* -------------------------------- 写 -------------------------------- */

    apply_string_edits: tool({
      description: promptText(lang, 'tools.apply_string_edits.description'),
      inputSchema: z.object({
        operations: z
          .array(
            z.object({
              type: z.enum(['replace', 'remove', 'insert_before', 'insert_after']),
              anchor_id: z.string(),
              content: z
                .string()
                .optional()
                .describe(promptText(lang, 'tools.apply_string_edits.parameters.content'))
            })
          )
          .min(1)
      }),
      execute: async (input) =>
        run('apply_string_edits', 'write', input, null, () => {
          const operations: StringEditOperation[] = input.operations.map((op, index) => {
            if (op.type === 'remove') return { type: 'remove', anchorId: op.anchor_id }
            if (op.content === undefined) {
              throw new VfsError(
                aiText('ai.tools.operationIsMissingContent', index + 1, op.type),
                'TOOL_EXECUTION_FAILED'
              )
            }
            return { type: op.type, anchorId: op.anchor_id, content: op.content }
          })
          const applied = editor.apply(operations)
          // 原子提交成功后才发 Monaco patch 事件
          for (const item of applied) emitPatch(item.patch)
          for (const item of applied) {
            ledger.noteWriteSuccess(
              item.path,
              vfs.revisionOf(item.path) ?? 0,
              'apply_string_edits',
              item.patch.newText.length
            )
          }
          const paths = applied.map((a) => a.path)
          return toolOk(aiText('ai.tools.completedAnchorEdits', paths.join('、')), paths)
        })
    }),

    edit_file: tool({
      description: promptText(lang, 'tools.edit_file.description'),
      inputSchema: z.object({
        path: z.string(),
        old_string: z.string().describe(promptText(lang, 'tools.edit_file.parameters.old_string')),
        new_string: z.string().describe(promptText(lang, 'tools.edit_file.parameters.new_string')),
        replace_all: z
          .boolean()
          .optional()
          .describe(promptText(lang, 'tools.edit_file.parameters.replace_all'))
      }),
      // 同 list_files:带可选字段的 schema 不能解构参数
      execute: async (input) =>
        run('edit_file', 'textPatch', input, input.path, () => {
          const patch = vfs.edit(input.path, input.old_string, input.new_string, input.replace_all)
          emitPatch(patch)
          ledger.noteWriteSuccess(
            patch.path,
            vfs.revisionOf(patch.path) ?? 0,
            'edit_file',
            input.new_string.length
          )
          return toolOk(aiText('ai.tools.edited', patch.path), [patch.path])
        })
    }),

    multi_edit_file: tool({
      description: promptText(lang, 'tools.multi_edit_file.description'),
      inputSchema: z.object({
        path: z.string(),
        edits: z
          .array(
            z.object({
              old_string: z.string(),
              new_string: z.string(),
              replace_all: z.boolean().optional()
            })
          )
          .min(1)
          .describe(promptText(lang, 'tools.multi_edit_file.parameters.edits'))
      }),
      execute: async (input) =>
        run('multi_edit_file', 'textPatch', input, input.path, () => {
          const patches = vfs.multiEdit(
            input.path,
            input.edits.map((e) => ({
              oldText: e.old_string,
              newText: e.new_string,
              replaceAll: e.replace_all
            }))
          )
          for (const patch of patches) emitPatch(patch)
          ledger.noteWriteSuccess(
            input.path,
            vfs.revisionOf(input.path) ?? 0,
            'multi_edit_file',
            input.edits.reduce((n, e) => n + e.new_string.length, 0)
          )
          return toolOk(aiText('ai.tools.completedEditsIn', input.path, patches.length), [
            input.path
          ])
        })
    }),

    apply_patch: tool({
      description: promptText(lang, 'tools.apply_patch.description'),
      inputSchema: z.object({
        patch: z.string().describe(promptText(lang, 'tools.apply_patch.parameters.patch'))
      }),
      execute: async (input) =>
        run('apply_patch', 'textPatch', input, null, () => {
          const ops = parsePatch(input.patch)
          // 已降级的文件拒绝再走文本补丁,提前挡在事务外
          for (const op of ops) {
            if (op.kind === 'update' && ledger.textPatchDisabled(op.path)) {
              return toolError(
                'MATCH_NOT_FOUND',
                aiText(
                  'ai.tools.textPatchesForHaveFailedTwiceInThisTurnFurtherTextPatches',
                  op.path
                ),
                ANCHORED_EDIT_RECOVERY
              )
            }
          }
          // 事件先攒着:补丁是原子的,改到第三个文件才失败时前两个要一起
          // 回滚,渲染层不能已经把它们画上去了
          const patches: VfsPatch[] = []
          const removed: string[] = []

          const done = vfs.transact(() => {
            const log: string[] = []
            for (const op of ops) {
              if (op.kind === 'delete') {
                const key = vfs.remove(op.path)
                removed.push(key)
                log.push(aiText('ai.tools.delete', key))
                continue
              }
              if (op.kind === 'add') {
                if (vfs.has(op.path)) {
                  throw new VfsError(
                    aiText('ai.tools.alreadyExistsUseUpdateFileInsteadOfAddFile', op.path),
                    'FILE_ALREADY_EXISTS'
                  )
                }
                patches.push(vfs.write(op.path, op.content))
                log.push(aiText('ai.tools.create', op.path))
                continue
              }
              const applied = vfs.multiEdit(
                op.path,
                op.hunks.map((h) => ({ oldText: h.before, newText: h.after }))
              )
              patches.push(...applied)
              log.push(aiText('ai.tools.updateChanges', op.path, applied.length))
            }
            return log
          })

          for (const p of patches) emitPatch(p)
          for (const path of removed) sink.onDelete(path)
          const affected = [...new Set([...patches.map((p) => p.path), ...removed])]
          for (const path of affected) {
            ledger.noteWriteSuccess(path, vfs.revisionOf(path) ?? 0, 'apply_patch', 0)
          }
          return toolOk(aiText('ai.tools.patchApplied', done.join('\n')), affected)
        })
    }),

    write_file: tool({
      description: promptText(lang, 'tools.write_file.description'),
      inputSchema: z.object({
        path: z.string(),
        content: z.string().describe(promptText(lang, 'tools.write_file.parameters.content'))
      }),
      execute: async (input) =>
        run('write_file', 'write', input, input.path, () => {
          const patch = vfs.write(input.path, input.content)
          emitPatch(patch)
          ledger.noteWriteSuccess(
            patch.path,
            vfs.revisionOf(patch.path) ?? 0,
            'write_file',
            input.content.length
          )
          return toolOk(aiText('ai.tools.wrote', patch.path), [patch.path])
        })
    }),

    move_file: tool({
      description: promptText(lang, 'tools.move_file.description'),
      inputSchema: z.object({
        from: z.string().describe(promptText(lang, 'tools.move_file.parameters.from')),
        to: z.string().describe(promptText(lang, 'tools.move_file.parameters.to'))
      }),
      execute: async (input) =>
        run('move_file', 'write', input, input.from, () => {
          const result = vfs.move(input.from, input.to)
          sink.onDelete(result.removed)
          emitPatch(result.patch)
          ledger.noteWriteSuccess(
            result.patch.path,
            vfs.revisionOf(result.patch.path) ?? 0,
            'move_file',
            0
          )
          return toolOk(aiText('ai.tools.movedTo', result.removed, result.patch.path), [
            result.removed,
            result.patch.path
          ])
        })
    }),

    copy_file: tool({
      description: promptText(lang, 'tools.copy_file.description'),
      inputSchema: z.object({ from: z.string(), to: z.string() }),
      execute: async (input) =>
        run('copy_file', 'write', input, input.from, () => {
          const patch = vfs.copy(input.from, input.to)
          emitPatch(patch)
          ledger.noteWriteSuccess(patch.path, vfs.revisionOf(patch.path) ?? 0, 'copy_file', 0)
          return toolOk(aiText('ai.tools.copiedTo', input.from, patch.path), [patch.path])
        })
    }),

    delete_file: tool({
      description: promptText(lang, 'tools.delete_file.description'),
      inputSchema: z.object({ path: z.string() }),
      execute: async (input) =>
        run('delete_file', 'write', input, input.path, () => {
          const key = vfs.remove(input.path)
          sink.onDelete(key)
          ledger.noteWriteSuccess(key, 0, 'delete_file', 0)
          return toolOk(aiText('ai.tools.deleted', key), [key])
        })
    }),

    /* ------------------------------- 自查 ------------------------------- */

    diff_changes: tool({
      description: promptText(lang, 'tools.diff_changes.description'),
      inputSchema: z.object({}),
      execute: async (input) =>
        run('diff_changes', 'neutral', input, null, () => {
          const changes = vfs.changes()
          if (changes.length === 0) return toolOk(aiText('ai.tools.noChangesInThisTurnYet'))
          return toolOk(
            changes
              .map((c) => {
                if (c.after === null) return aiText('ai.tools.devNullEntireFileDeleted', c.path)
                if (c.before === '') return aiText('ai.tools.devNullNewFile', c.path)
                return (
                  unifiedDiff(c.path, c.before, c.after) || aiText('ai.tools.isUnchanged', c.path)
                )
              })
              .join('\n\n')
          )
        })
    }),

    check_syntax: tool({
      description: promptText(lang, 'tools.check_syntax.description'),
      inputSchema: z.object({
        path: z.string().optional().describe(promptText(lang, 'tools.check_syntax.parameters.path'))
      }),
      execute: async (input) =>
        run('check_syntax', 'neutral', input, input.path ?? null, () => {
          const targets = input.path
            ? [vfs.raw(input.path)]
            : vfs
                .changes()
                .filter((c) => c.after !== null)
                .map((c) => ({ path: c.path, content: c.after! }))

          if (targets.length === 0)
            return toolOk(aiText('ai.tools.noFilesHaveChangedInThisTurnThereIsNothingToCheck'))

          const report = targets.map((file) => {
            const problems = checkSyntax(file.path, file.content)
            const parts: string[] = []
            // 真编译走在结构检查前面:编译器的报错比括号计数具体得多
            const compileError = compileProbe(file.path, file.content)
            if (compileError)
              parts.push(aiText('ai.tools.compilationFailed', file.path, compileError))
            if (problems.length === 0) {
              if (!compileError)
                parts.push(aiText('ai.tools.noStructuralOrCompilationIssuesFound', file.path))
            } else {
              const lines = problems.map((p) => `  ${p.line}:${p.column} ${p.message}`)
              parts.push(aiText('ai.tools.issues', file.path, problems.length, lines.join('\n')))
            }
            // 可编辑性警告:超过 800 字符的单行下次编辑几乎必然截断失败。
            // 只提醒,不阻止保存
            const longLines = file.content
              .split('\n')
              .map((line, i) => ({ line: i + 1, chars: line.length }))
              .filter((l) => l.chars > 800)
            if (longLines.length) {
              const detail = longLines
                .slice(0, 5)
                .map((l) => aiText('ai.tools.lineCharacters', l.line, l.chars))
                .join('、')
              parts.push(
                aiText(
                  'ai.tools.editabilityWarningFormatLargeArraysColumnsOptionsAcrossMultipleLines',
                  detail
                ) + aiText('ai.tools.useCaptureRangeApplyStringEditsToEditTheseLines')
              )
            }
            return parts.join('\n')
          })
          return toolOk(report.join('\n'))
        })
    }),

    revert_file: tool({
      description: promptText(lang, 'tools.revert_file.description'),
      inputSchema: z.object({ path: z.string() }),
      execute: async (input) =>
        run('revert_file', 'write', input, input.path, () => {
          const result = vfs.revert(input.path)
          if (result.deleted) {
            sink.onDelete(result.deleted)
            ledger.noteWriteSuccess(result.deleted, 0, 'revert_file', 0)
            return toolOk(
              aiText('ai.tools.wasCreatedInThisTurnAndHasBeenRevertedTheFileNo', result.deleted)
            )
          }
          emitPatch(result.patch!)
          ledger.noteWriteSuccess(
            result.patch!.path,
            vfs.revisionOf(result.patch!.path) ?? 0,
            'revert_file',
            0
          )
          return toolOk(
            aiText('ai.tools.wasRestoredToItsContentAtTheStartOfThisTurn', result.patch!.path)
          )
        })
    })
  }
  return localizedTools(tools, lang)
}
