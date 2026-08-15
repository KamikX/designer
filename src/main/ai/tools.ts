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
  return `${text.slice(0, MAX_RESULT_CHARS)}\n\n…结果过长已截断(共 ${text.length} 字符)。请缩小范围重试。`
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
  if (hits.length === 0) return '没有匹配。可以放宽关键词,或用 list_files 确认文件范围。'
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
    ? '\n\n注意:预览行有截断,**不可**把预览当 old_string 抄写;编辑请用 matchId 走 apply_string_edits。'
    : ''
  return `${hits.length} 处匹配:\n\n${blocks.join(withContext ? '\n\n' : '\n')}${note}`
}

/** 工具按职责分类,写入闸门与补丁降级只对相应类别生效 */
type ToolKind = 'read' | 'locate' | 'textPatch' | 'write' | 'neutral'

export function buildFileTools(
  vfs: SessionVfs,
  sink: FileToolSink,
  options: FileToolOptions = {}
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
          toolError('TOOL_EXECUTION_FAILED', `写入已锁定(${fatal}),本轮不能再修改文件。`)
        )
      }
      if (ledger.writesPaused()) {
        return renderToolResult(
          toolError(
            'TOOL_EXECUTION_FAILED',
            '连续 3 次写入失败,已暂停写入。先用 search_files / read_file / capture_range 重新定位,再继续修改。'
          )
        )
      }
      if (kind === 'textPatch' && path && ledger.textPatchDisabled(path)) {
        return renderToolResult(
          toolError(
            'MATCH_NOT_FOUND',
            `${path} 的文本补丁在本轮已两次失败,该文件不再接受文本补丁。`,
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
          `重复调用:同参数的 ${name} 刚执行过且目标未变化。直接使用上次结果,不要原样重试。`
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
            `\n\n⚠ 改动已保存,但以下文件真编译不通过,预览会白屏——交付前必须修复:\n` +
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
        ledger.lockFatal(`工具 ${name} 发生非预期错误`)
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
      description:
        '列出设计稿的文件,附带每个文件的行数。先看这个再决定要不要打开文件。' +
        '可以用 glob 缩小范围,如 `css/**` 或 `*.html`。',
      inputSchema: z.object({
        glob: z.string().optional().describe('路径通配,支持 * ** ?;缺省列出全部')
      }),
      // 参数不解构:schema 带可选字段时,解构模式会参与 INPUT 泛型推断
      // 并把它压成 never,inputSchema 随即报类型不匹配
      execute: async (input) =>
        run('list_files', 'read', input, null, () => {
          const stats = vfs.stats(input.glob)
          if (stats.length === 0) {
            return toolOk(input.glob ? `没有匹配 ${input.glob} 的文件。` : '(设计稿还没有任何文件)')
          }
          return toolOk(stats.map((s) => `${s.path}\t${s.lines} 行`).join('\n'))
        })
    }),

    outline_file: tool({
      description:
        '看文件的结构大纲(带行号的骨架:html 的区块与 id、css 的选择器、js 的顶层声明)。' +
        '定位用它,比整份读文件便宜一个数量级。确定了大概位置再用 read_file 取那一段。',
      inputSchema: z.object({ path: z.string() }),
      execute: async (input) =>
        run('outline_file', 'read', input, input.path, () => toolOk(vfs.outline(input.path)))
    }),

    read_file: tool({
      description:
        '按行区间读取文件,返回带行号的文本。行号仅供定位参考,不要用于编辑——编辑一律靠锚点。' +
        '**尽量带上 start_line / end_line 只读需要的那一段**;不带区间时会截断,并把区间之外的结构大纲一并返回。' +
        '单行超过 800 字符会被截断显示,这样的行不要抄进 old_string,改用 capture_range 取锚点。',
      inputSchema: z.object({
        path: z.string().describe('相对路径,如 css/style.css'),
        start_line: z.number().int().min(1).optional().describe('起始行号,从 1 开始(含)'),
        end_line: z.number().int().min(1).optional().describe('结束行号(含)')
      }),
      execute: async (input) =>
        run('read_file', 'read', input, input.path, () =>
          toolOk(vfs.read(input.path, input.start_line, input.end_line))
        )
    }),

    get_range: tool({
      description:
        '按行列精确取出原文,**不带行号**——取到的字符串可以原样当 edit_file 的 old_string 用。' +
        'search_files 给出行列之后用它取锚点,能避免手抄导致的缩进/空白对不上。',
      inputSchema: z.object({
        path: z.string(),
        start_line: z.number().int().min(1).describe('起始行,从 1 开始(含)'),
        end_line: z.number().int().min(1).optional().describe('结束行(含),缺省为只取起始行'),
        start_column: z.number().int().min(1).optional().describe('起始列,缺省为行首'),
        end_column: z.number().int().min(1).optional().describe('结束列(含),缺省为行尾')
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
      description:
        '把任意范围捕获为**服务端锚点**:返回精确不截断的原文和 anchorId,之后用 apply_string_edits 按 anchorId 修改。' +
        '超长行、被截断的预览、第一次补丁失败后,一律用它代替手抄 old_string。' +
        '行列 1 起、两端包含;列按 UTF-16 计数;删整行时传 include_trailing_newline 把换行一起圈进来。',
      inputSchema: z.object({
        path: z.string(),
        start_line: z.number().int().min(1).describe('起始行,从 1 开始(含)'),
        end_line: z.number().int().min(1).optional().describe('结束行(含),缺省等于起始行'),
        start_column: z.number().int().min(1).optional().describe('起始列(含),缺省为行首'),
        end_column: z.number().int().min(1).optional().describe('结束列(含),缺省为行尾'),
        include_trailing_newline: z
          .boolean()
          .optional()
          .describe('把结束行后的换行并入锚点(整行删除用),缺省 false')
      }),
      execute: async (input) =>
        run('capture_range', 'locate', input, input.path, () => {
          const revision = vfs.revisionOf(input.path)
          if (revision === null) throw new VfsError(`文件不存在:${input.path}。`)
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
      description:
        '全文搜索,返回 `路径:行:列 [matchId]` 与命中行内容。**这是定位的首选**。' +
        '每个命中带 matchId,可直接作为 apply_string_edits 的锚点——预览被截断也不影响,' +
        '因为区间由服务端持有。想看命中点周围就带 context_lines。每行只报第一处命中。',
      inputSchema: z.object({
        query: z.string().describe('要找的文本,如 `--brand` 或 `class="hero"`'),
        is_regex: z.boolean().optional().describe('query 按正则解析,缺省按纯文本'),
        glob: z.string().optional().describe('只搜路径匹配该通配的文件'),
        context_lines: z.number().int().min(0).max(5).optional().describe('每处命中前后带几行'),
        case_sensitive: z.boolean().optional().describe('区分大小写,缺省不区分'),
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
      description:
        '按锚点批量编辑,**不需要复述原文**:anchor_id 来自 capture_range 或 search_files 的 matchId。' +
        '四种操作:replace(替换锚点内容)、remove(删除)、insert_before / insert_after(在锚点前后插入)。' +
        '同一锚点可组合 before+replace+after;跨文件原子提交,任何一处失败整批回滚。' +
        '超长行、截断行、文本补丁失败后,用它是默认选择。',
      inputSchema: z.object({
        operations: z
          .array(
            z.object({
              type: z.enum(['replace', 'remove', 'insert_before', 'insert_after']),
              anchor_id: z.string(),
              content: z.string().optional().describe('replace / insert_* 的新内容;remove 不需要')
            })
          )
          .min(1)
      }),
      execute: async (input) =>
        run('apply_string_edits', 'write', input, null, () => {
          const operations: StringEditOperation[] = input.operations.map((op, index) => {
            if (op.type === 'remove') return { type: 'remove', anchorId: op.anchor_id }
            if (op.content === undefined) {
              throw new VfsError(`第 ${index + 1} 个操作(${op.type})缺少 content。`)
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
          return toolOk(`已按锚点完成编辑:${paths.join('、')}`, paths)
        })
    }),

    edit_file: tool({
      description:
        '替换文件中的一处内容。old_string 必须与原文逐字符一致(含缩进与空行)且在文件中唯一。' +
        '同一个文件要改多处时用 multi_edit_file;原文超长或曾被截断时改用 capture_range + apply_string_edits。',
      inputSchema: z.object({
        path: z.string(),
        old_string: z.string().describe('被替换的原文,必须逐字符一致'),
        new_string: z.string().describe('替换后的新内容'),
        replace_all: z.boolean().optional().describe('原文出现多处且都要替换时传 true')
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
          return toolOk(`已编辑 ${patch.path}`, [patch.path])
        })
    }),

    multi_edit_file: tool({
      description:
        '在同一个文件里一次做多处替换,按顺序施加,全成或全不成(任何一处锚点对不上就整体回滚)。' +
        '改同一个文件的多个地方时优先用它——每多一轮工具调用,整个对话都要重发一遍。',
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
          .describe('按施加顺序排列;每处的 old_string 都要在当时的文件里唯一')
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
          return toolOk(`已在 ${input.path} 完成 ${patches.length} 处编辑`, [input.path])
        })
    }),

    apply_patch: tool({
      description:
        '用补丁一次改多个文件,适合**短行、格式规整**的小 hunk 与 Add/Delete。格式(不带行号,靠上下文行定位):\n' +
        '*** Begin Patch\n' +
        '*** Update File: css/style.css\n' +
        '@@\n' +
        ' .hero {\n' +
        '-  color: red;\n' +
        '+  color: #1677ff;\n' +
        ' }\n' +
        '*** Add File: css/theme.css\n' +
        '+:root { --brand: #1677ff; }\n' +
        '*** Delete File: css/old.css\n' +
        '*** End Patch\n' +
        '每个 hunk 必须带至少一行上下文(以空格开头)用于定位,且在文件中唯一。' +
        '涉及超长行或补丁曾失败的文件,改用 capture_range/matchId + apply_string_edits。',
      inputSchema: z.object({ patch: z.string().describe('完整补丁文本') }),
      execute: async (input) =>
        run('apply_patch', 'textPatch', input, null, () => {
          const ops = parsePatch(input.patch)
          // 已降级的文件拒绝再走文本补丁,提前挡在事务外
          for (const op of ops) {
            if (op.kind === 'update' && ledger.textPatchDisabled(op.path)) {
              return toolError(
                'MATCH_NOT_FOUND',
                `${op.path} 的文本补丁在本轮已两次失败,该文件不再接受文本补丁。`,
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
                log.push(`删除 ${key}`)
                continue
              }
              if (op.kind === 'add') {
                if (vfs.has(op.path)) {
                  throw new VfsError(`${op.path} 已存在,不能用 Add File;改用 Update File。`)
                }
                patches.push(vfs.write(op.path, op.content))
                log.push(`新建 ${op.path}`)
                continue
              }
              const applied = vfs.multiEdit(
                op.path,
                op.hunks.map((h) => ({ oldText: h.before, newText: h.after }))
              )
              patches.push(...applied)
              log.push(`更新 ${op.path}(${applied.length} 处)`)
            }
            return log
          })

          for (const p of patches) emitPatch(p)
          for (const path of removed) sink.onDelete(path)
          const affected = [...new Set([...patches.map((p) => p.path), ...removed])]
          for (const path of affected) {
            ledger.noteWriteSuccess(path, vfs.revisionOf(path) ?? 0, 'apply_patch', 0)
          }
          return toolOk(`补丁已应用:\n${done.join('\n')}`, affected)
        })
    }),

    write_file: tool({
      description:
        '整份写入文件——用于新建文件,或改动幅度过大时的重写。' +
        '已有文件的局部修改一律用 edit_file / multi_edit_file / apply_string_edits,不要为了改一处而重写整份。',
      inputSchema: z.object({
        path: z.string(),
        content: z.string().describe('文件完整内容,不允许出现"其余保持不变"这类占位')
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
          return toolOk(`已写入 ${patch.path}`, [patch.path])
        })
    }),

    move_file: tool({
      description:
        '重命名或移动文件。**不要用 write_file + delete_file 代替**——那要把整份内容再吐一遍,' +
        '而这个操作根本不需要内容参与。',
      inputSchema: z.object({
        from: z.string().describe('原路径'),
        to: z.string().describe('新路径,不能是已存在的文件')
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
          return toolOk(`已把 ${result.removed} 移到 ${result.patch.path}`, [
            result.removed,
            result.patch.path
          ])
        })
    }),

    copy_file: tool({
      description:
        '复制文件。要基于现有页面做一个变体时用它,再在副本上 edit_file,' +
        '比 write_file 整份重打一遍省得多。',
      inputSchema: z.object({ from: z.string(), to: z.string() }),
      execute: async (input) =>
        run('copy_file', 'write', input, input.from, () => {
          const patch = vfs.copy(input.from, input.to)
          emitPatch(patch)
          ledger.noteWriteSuccess(patch.path, vfs.revisionOf(patch.path) ?? 0, 'copy_file', 0)
          return toolOk(`已把 ${input.from} 复制为 ${patch.path}`, [patch.path])
        })
    }),

    delete_file: tool({
      description: '删除文件。',
      inputSchema: z.object({ path: z.string() }),
      execute: async (input) =>
        run('delete_file', 'write', input, input.path, () => {
          const key = vfs.remove(input.path)
          sink.onDelete(key)
          ledger.noteWriteSuccess(key, 0, 'delete_file', 0)
          return toolOk(`已删除 ${key}`, [key])
        })
    }),

    /* ------------------------------- 自查 ------------------------------- */

    diff_changes: tool({
      description:
        '看本回合到目前为止改了什么(unified diff)。收尾前自查用,比重新读一遍文件便宜得多。',
      inputSchema: z.object({}),
      execute: async (input) =>
        run('diff_changes', 'neutral', input, null, () => {
          const changes = vfs.changes()
          if (changes.length === 0) return toolOk('本回合还没有任何改动。')
          return toolOk(
            changes
              .map((c) => {
                if (c.after === null) return `--- ${c.path}\n+++ /dev/null\n(整份删除)`
                if (c.before === '') return `--- /dev/null\n+++ ${c.path}\n(新建文件)`
                return unifiedDiff(c.path, c.before, c.after) || `(${c.path} 内容未变)`
              })
              .join('\n\n')
          )
        })
    }),

    check_syntax: tool({
      description:
        '语法自检:括号 / 标签配对,且 vue/tsx/ts/css 走与预览完全相同的真编译器。' +
        '改完收尾前跑一遍,别把编译不过的版本交出去。不传 path 就检查本回合动过的所有文件。',
      inputSchema: z.object({
        path: z.string().optional().describe('缺省时检查本回合改动过的全部文件')
      }),
      execute: async (input) =>
        run('check_syntax', 'neutral', input, input.path ?? null, () => {
          const targets = input.path
            ? [vfs.raw(input.path)]
            : vfs
                .changes()
                .filter((c) => c.after !== null)
                .map((c) => ({ path: c.path, content: c.after! }))

          if (targets.length === 0) return toolOk('本回合还没有改动过任何文件,没什么可检查的。')

          const report = targets.map((file) => {
            const problems = checkSyntax(file.path, file.content)
            const parts: string[] = []
            // 真编译走在结构检查前面:编译器的报错比括号计数具体得多
            const compileError = compileProbe(file.path, file.content)
            if (compileError) parts.push(`${file.path}:真编译失败\n  ${compileError}`)
            if (problems.length === 0) {
              if (!compileError) parts.push(`${file.path}:结构与编译都没发现问题`)
            } else {
              const lines = problems.map((p) => `  ${p.line}:${p.column} ${p.message}`)
              parts.push(`${file.path}:${problems.length} 个问题\n${lines.join('\n')}`)
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
                .map((l) => `第 ${l.line} 行 ${l.chars} 字符`)
                .join('、')
              parts.push(
                `  可编辑性警告:${detail}。建议把大型数组 / columns / options 多行格式化;` +
                  '如需修改这些行,用 capture_range + apply_string_edits。'
              )
            }
            return parts.join('\n')
          })
          return toolOk(report.join('\n'))
        })
    }),

    revert_file: tool({
      description:
        '把一个文件退回本回合开始时的样子。改坏了想重来时用它——' +
        '重写一份自己刚弄坏的文件最容易越描越黑。',
      inputSchema: z.object({ path: z.string() }),
      execute: async (input) =>
        run('revert_file', 'write', input, input.path, () => {
          const result = vfs.revert(input.path)
          if (result.deleted) {
            sink.onDelete(result.deleted)
            ledger.noteWriteSuccess(result.deleted, 0, 'revert_file', 0)
            return toolOk(`${result.deleted} 是本回合新建的,已撤销(文件不再存在)`)
          }
          emitPatch(result.patch!)
          ledger.noteWriteSuccess(
            result.patch!.path,
            vfs.revisionOf(result.patch!.path) ?? 0,
            'revert_file',
            0
          )
          return toolOk(`${result.patch!.path} 已回到本回合开始时的内容`)
        })
    })
  }
  return tools
}
