import { tool } from 'ai'
import type { ToolSet } from 'ai'
import { z } from 'zod'
import { SessionVfs } from './session-vfs'
import type { SearchHit, VfsPatch } from './session-vfs'
import { VfsError } from './vfs-error'
import { parsePatch } from './patch-format'
import { unifiedDiff } from './text-diff'
import { checkSyntax } from './text-syntax'

/**
 * 给模型的文件工具集,分工照 VS Code agent 那套(readFile / textSearch /
 * fileSearch / listDirectory / editFiles / changes)裁剪到设计稿这个场景。
 *
 * ## 四条设计原则
 *
 * 1. **用锚点字符串定位,不用行号。** 行号在连续编辑中会漂移——模型
 *    基于第 2 步读到的行号做第 5 步的编辑必然错位。行号只用于读和描述
 *    位置,写一律靠唯一字符串匹配。get_range 是这条的配套:按行列把原文
 *    精确取出来直接当锚点,省掉"读一段再手抄"以及手抄抄错。
 *
 * 2. **能搜就别读,能读一段就别读整份。** search_files 直接给命中行和
 *    上下文,outline_file 给骨架,read_file 有硬上限且会把区间之外的结构
 *    大纲一并带回。整份读文件是最后手段。
 *
 * 3. **能一次改完就别分多次。** 工具循环每多走一步,整个对话历史就要
 *    重发一遍——步数本身就是 token,而且是乘在上下文长度上的。所以同
 *    一文件多处用 multi_edit_file,跨文件用 apply_patch。
 *
 * 4. **错误说人话,且当作工具结果返回而不是抛出。** 抛异常会中断
 *    streamText 循环;返回错误文本则让模型看见并自己纠正。VfsError 的
 *    message 就是写给模型看的指引。
 */

/** 单个工具结果的字符上限:结果会随每一步重发,放任下去等于持续漏 token */
const MAX_RESULT_CHARS = 12000

/** 把 VfsError 转成工具结果文本;非预期错误照常抛 */
async function guarded(run: () => string): Promise<string> {
  try {
    return capped(run())
  } catch (err) {
    if (err instanceof VfsError) return `错误:${err.message}`
    throw err
  }
}

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

function renderHits(hits: SearchHit[], withContext: boolean): string {
  if (hits.length === 0) return '没有匹配。可以放宽关键词,或用 list_files 确认文件范围。'
  const blocks = hits.map((hit) => {
    const head = `${hit.path}:${hit.line}:${hit.column}`
    if (!withContext) return `${head}: ${hit.text}`
    const before = hit.before.map((l, i) => `  ${hit.line - hit.before.length + i}  ${l}`)
    const after = hit.after.map((l, i) => `  ${hit.line + 1 + i}  ${l}`)
    return [head, ...before, `> ${hit.line}  ${hit.text}`, ...after].join('\n')
  })
  return `${hits.length} 处匹配:\n\n${blocks.join(withContext ? '\n\n' : '\n')}`
}

export function buildFileTools(vfs: SessionVfs, sink: FileToolSink): ToolSet {
  const emitPatch = sink.onPatch
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
        guarded(() => {
          const stats = vfs.stats(input.glob)
          if (stats.length === 0) {
            return input.glob ? `没有匹配 ${input.glob} 的文件。` : '(设计稿还没有任何文件)'
          }
          return stats.map((s) => `${s.path}\t${s.lines} 行`).join('\n')
        })
    }),

    outline_file: tool({
      description:
        '看文件的结构大纲(带行号的骨架:html 的区块与 id、css 的选择器、js 的顶层声明)。' +
        '定位用它,比整份读文件便宜一个数量级。确定了大概位置再用 read_file 取那一段。',
      inputSchema: z.object({ path: z.string() }),
      execute: async ({ path }) => guarded(() => vfs.outline(path))
    }),

    read_file: tool({
      description:
        '按行区间读取文件,返回带行号的文本。行号仅供定位参考,不要用于编辑——编辑一律靠 old_string 锚点。' +
        '**尽量带上 start_line / end_line 只读需要的那一段**;不带区间时会截断,并把区间之外的结构大纲一并返回。',
      inputSchema: z.object({
        path: z.string().describe('相对路径,如 css/style.css'),
        start_line: z.number().int().min(1).optional().describe('起始行号,从 1 开始(含)'),
        end_line: z.number().int().min(1).optional().describe('结束行号(含)')
      }),
      execute: async (input) =>
        guarded(() => vfs.read(input.path, input.start_line, input.end_line))
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
        guarded(() =>
          vfs.getRange(
            input.path,
            input.start_line,
            input.end_line,
            input.start_column,
            input.end_column
          )
        )
    }),

    search_files: tool({
      description:
        '全文搜索,返回 `路径:行:列` 与命中行内容。' +
        '**这是定位的首选**:多数修改靠搜索就能找到位置,根本不必打开文件。' +
        '想看命中点周围长什么样就带 context_lines。每行只报第一处命中。',
      inputSchema: z.object({
        query: z.string().describe('要找的文本,如 `--brand` 或 `class="hero"`'),
        is_regex: z.boolean().optional().describe('query 按正则解析,缺省按纯文本'),
        glob: z.string().optional().describe('只搜路径匹配该通配的文件'),
        context_lines: z.number().int().min(0).max(5).optional().describe('每处命中前后带几行'),
        case_sensitive: z.boolean().optional().describe('区分大小写,缺省不区分'),
        max_results: z.number().int().min(1).max(60).optional()
      }),
      execute: async (input) =>
        guarded(() => {
          const hits = vfs.search(input.query, {
            regex: input.is_regex,
            glob: input.glob,
            contextLines: input.context_lines,
            caseSensitive: input.case_sensitive,
            maxResults: input.max_results
          })
          return renderHits(hits, (input.context_lines ?? 0) > 0)
        })
    }),

    /* -------------------------------- 写 -------------------------------- */

    edit_file: tool({
      description:
        '替换文件中的一处内容。old_string 必须与原文逐字符一致(含缩进与空行)且在文件中唯一,' +
        '为此要带上足够的上下文行。同一个文件要改多处时用 multi_edit_file,别连着调这个。',
      inputSchema: z.object({
        path: z.string(),
        old_string: z.string().describe('被替换的原文,必须逐字符一致'),
        new_string: z.string().describe('替换后的新内容'),
        replace_all: z.boolean().optional().describe('原文出现多处且都要替换时传 true')
      }),
      // 同 list_files:带可选字段的 schema 不能解构参数
      execute: async (input) =>
        guarded(() => {
          const patch = vfs.edit(input.path, input.old_string, input.new_string, input.replace_all)
          emitPatch(patch)
          return `已编辑 ${patch.path}`
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
        guarded(() => {
          const patches = vfs.multiEdit(
            input.path,
            input.edits.map((e) => ({
              oldText: e.old_string,
              newText: e.new_string,
              replaceAll: e.replace_all
            }))
          )
          for (const patch of patches) emitPatch(patch)
          return `已在 ${input.path} 完成 ${patches.length} 处编辑`
        })
    }),

    apply_patch: tool({
      description:
        '用补丁一次改多个文件,是跨文件改动的首选。格式(不带行号,靠上下文行定位):\n' +
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
        '每个 hunk 必须带至少一行上下文(以空格开头)用于定位,且在文件中唯一。',
      inputSchema: z.object({ patch: z.string().describe('完整补丁文本') }),
      execute: async ({ patch }) =>
        guarded(() => {
          const ops = parsePatch(patch)
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
          return `补丁已应用:\n${done.join('\n')}`
        })
    }),

    write_file: tool({
      description:
        '整份写入文件——用于新建文件,或改动幅度过大时的重写。' +
        '已有文件的局部修改一律用 edit_file / multi_edit_file,不要为了改一处而重写整份。',
      inputSchema: z.object({
        path: z.string(),
        content: z.string().describe('文件完整内容,不允许出现"其余保持不变"这类占位')
      }),
      execute: async ({ path, content }) =>
        guarded(() => {
          const patch = vfs.write(path, content)
          emitPatch(patch)
          return `已写入 ${patch.path}`
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
      execute: async ({ from, to }) =>
        guarded(() => {
          const result = vfs.move(from, to)
          sink.onDelete(result.removed)
          emitPatch(result.patch)
          return `已把 ${result.removed} 移到 ${result.patch.path}`
        })
    }),

    copy_file: tool({
      description:
        '复制文件。要基于现有页面做一个变体时用它,再在副本上 edit_file,' +
        '比 write_file 整份重打一遍省得多。',
      inputSchema: z.object({ from: z.string(), to: z.string() }),
      execute: async ({ from, to }) =>
        guarded(() => {
          const patch = vfs.copy(from, to)
          emitPatch(patch)
          return `已把 ${from} 复制为 ${patch.path}`
        })
    }),

    delete_file: tool({
      description: '删除文件。',
      inputSchema: z.object({ path: z.string() }),
      execute: async ({ path }) =>
        guarded(() => {
          const key = vfs.remove(path)
          sink.onDelete(key)
          return `已删除 ${key}`
        })
    }),

    /* ------------------------------- 自查 ------------------------------- */

    diff_changes: tool({
      description:
        '看本回合到目前为止改了什么(unified diff)。收尾前自查用,比重新读一遍文件便宜得多。',
      inputSchema: z.object({}),
      execute: async () =>
        guarded(() => {
          const changes = vfs.changes()
          if (changes.length === 0) return '本回合还没有任何改动。'
          return changes
            .map((c) => {
              if (c.after === null) return `--- ${c.path}\n+++ /dev/null\n(整份删除)`
              if (c.before === '') return `--- /dev/null\n+++ ${c.path}\n(新建文件)`
              return unifiedDiff(c.path, c.before, c.after) || `(${c.path} 内容未变)`
            })
            .join('\n\n')
        })
    }),

    check_syntax: tool({
      description:
        '结构自检:括号 / 标签是否配对、JSON 能不能解析。改完收尾前跑一遍,' +
        '别把括号少一个的版本交出去。不传 path 就检查本回合动过的所有文件。' +
        '注意这**不是**完整的语法校验,只报有把握的硬错误。',
      inputSchema: z.object({
        path: z.string().optional().describe('缺省时检查本回合改动过的全部文件')
      }),
      execute: async (input) =>
        guarded(() => {
          const targets = input.path
            ? [vfs.raw(input.path)]
            : vfs
                .changes()
                .filter((c) => c.after !== null)
                .map((c) => ({ path: c.path, content: c.after! }))

          if (targets.length === 0) return '本回合还没有改动过任何文件,没什么可检查的。'

          const report = targets.map((file) => {
            const problems = checkSyntax(file.path, file.content)
            if (problems.length === 0) return `${file.path}:没发现结构问题`
            const lines = problems.map((p) => `  ${p.line}:${p.column} ${p.message}`)
            return `${file.path}:${problems.length} 个问题\n${lines.join('\n')}`
          })
          return report.join('\n')
        })
    }),

    revert_file: tool({
      description:
        '把一个文件退回本回合开始时的样子。改坏了想重来时用它——' +
        '重写一份自己刚弄坏的文件最容易越描越黑。',
      inputSchema: z.object({ path: z.string() }),
      execute: async ({ path }) =>
        guarded(() => {
          const result = vfs.revert(path)
          if (result.deleted) {
            sink.onDelete(result.deleted)
            return `${result.deleted} 是本回合新建的,已撤销(文件不再存在)`
          }
          emitPatch(result.patch!)
          return `${result.patch!.path} 已回到本回合开始时的内容`
        })
    })
  }
  return tools
}
