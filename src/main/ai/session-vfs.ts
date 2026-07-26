import type { ArtifactFile } from '../../shared/types'
import { VfsError } from './vfs-error'
import { clip, outlineBetween, outlineOf, renderOutline } from './text-outline'

/**
 * 一个回合内的文件真值。
 *
 * 为什么真值放主进程而不是塞进渲染层的 monaco model:工具调用跑在
 * 主进程的 streamText 循环里,而 monaco model 活在渲染进程。让工具反向
 * IPC 进渲染层读写,等于把 AI 链路的正确性押在"窗口开着、可见、只有
 * 一个、没切路由"上——切项目页、关窗后台生成、开第二个窗口全都会断。
 * 而且纯 TS 的 VFS 能直接进 vitest,跨进程的不能。
 *
 * Monaco 只是它的镜像:每次改动 emit 一个 VfsPatch,渲染层就地 applyEdits。
 *
 * 回合结束时 writes / deletes 的形状与 FileStreamParser 的 files / deleted
 * 完全一致——createArtifactVersion 和数据库 schema 一个字都不用改。
 *
 * ## 省 token 的三个约束(照 VS Code agent 的做法)
 *
 * 1. **读一律有上限。** read 不给区间时最多吐 MAX_READ_LINES 行,余下的
 *    只给结构大纲;单行超过 MAX_LINE_CHARS 也截断——设计稿里压过的 css
 *    一行能有几万字符,喂进去就是一次性烧光上下文。
 * 2. **先搜再读。** search 直接返回带行号的命中行与上下文,模型多数时候
 *    根本不需要打开文件。
 * 3. **批量写。** multiEdit / 补丁一次改多处。工具循环每多走一步,整个
 *    对话历史就要重发一遍,步数本身就是 token。
 */

export { VfsError }

export interface VfsPatch {
  path: string
  /** 锚点原文;空串表示整份替换(新建或全文重写),渲染层据此走全量分支 */
  oldText: string
  newText: string
  /** oldText 在文件中出现多处且允许全替时为 true */
  replaceAll?: boolean
}

/** 不带区间时单次最多读多少行 */
export const MAX_READ_LINES = 400
/** 单行超过这个长度就截断 */
export const MAX_LINE_CHARS = 800
/** search 默认 / 最多返回多少条命中 */
export const DEFAULT_SEARCH_RESULTS = 20
export const MAX_SEARCH_RESULTS = 60

export interface SearchOptions {
  /** query 按正则解析,默认按纯文本 */
  regex?: boolean
  /** 只搜路径匹配该 glob 的文件,如 `css/**` 或 `*.html` */
  glob?: string
  /** 每条命中前后各带几行上下文 */
  contextLines?: number
  maxResults?: number
  caseSensitive?: boolean
}

export interface SearchHit {
  path: string
  /** 1 起 */
  line: number
  /** 1 起 */
  column: number
  text: string
  before: string[]
  after: string[]
}

export interface FileStat {
  path: string
  lines: number
  chars: number
}

export interface EditSpec {
  oldText: string
  newText: string
  replaceAll?: boolean
}

/** 路径规则与 <antdFile> 协议一致:相对路径、不含 ..、不以 / 开头 */
function assertPath(path: string): string {
  const trimmed = path.trim()
  if (!trimmed) throw new VfsError('路径不能为空。')
  if (trimmed.startsWith('/') || /^[A-Za-z]:/.test(trimmed)) {
    throw new VfsError('路径必须是相对路径,不能以 / 或盘符开头。')
  }
  const normalized = trimmed.replace(/\\/g, '/')
  if (normalized.split('/').includes('..')) {
    throw new VfsError('路径不允许包含 .. 。')
  }
  return normalized
}

/**
 * 同 assertPath,但非法时返回 null 而不是抛。
 * 导出给观测层的 sanitizer 复用——诊断里只允许出现真正合法的设计稿
 * 相对路径,不能收一个"看起来像相对路径"的任意字符串。
 */
export function safePath(path: string): string | null {
  try {
    return assertPath(path)
  } catch {
    return null
  }
}

/** 支持 `*`(不跨目录)、`**`(跨目录)、`?` 的极简 glob */
export function globToRegExp(glob: string): RegExp {
  let body = ''
  const source = glob.trim()
  for (let i = 0; i < source.length; i++) {
    const ch = source[i]
    if (ch === '*') {
      if (source[i + 1] === '*') {
        // `**/` 连零层目录也算匹配,这样 `**/*.css` 能命中根目录下的文件
        if (source[i + 2] === '/') {
          body += '(?:.*/)?'
          i += 2
        } else {
          body += '.*'
          i += 1
        }
      } else {
        body += '[^/]*'
      }
      continue
    }
    if (ch === '?') {
      body += '[^/]'
      continue
    }
    body += /[.+^${}()|[\]\\]/.test(ch) ? `\\${ch}` : ch
  }
  return new RegExp(`^${body}$`)
}

/** 非重叠计数 */
function countOccurrences(haystack: string, needle: string): number {
  let count = 0
  let from = 0
  for (;;) {
    const at = haystack.indexOf(needle, from)
    if (at < 0) return count
    count += 1
    from = at + needle.length
  }
}

function replaceFirst(haystack: string, needle: string, replacement: string): string {
  const at = haystack.indexOf(needle)
  if (at < 0) return haystack
  // 不用 String.replace:替换串里的 $& / $1 会被当成模式展开
  return haystack.slice(0, at) + replacement + haystack.slice(at + needle.length)
}

function replaceEvery(haystack: string, needle: string, replacement: string): string {
  return haystack.split(needle).join(replacement)
}

/** 末尾换行会切出一个空串,不该算作一行 */
export function toLines(content: string): string[] {
  if (content === '') return []
  const lines = content.split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  return lines
}

export class SessionVfs {
  private readonly files: Map<string, string>
  /** 回合开始时的快照,diff 用 */
  private readonly original: Map<string, string>
  /** 本回合新建或改过的路径 */
  private readonly touched = new Set<string>()
  /** 本回合删掉的路径 */
  private readonly removed = new Set<string>()
  /** 写入闸门:首次风格未确认、或视觉方向保存失败时阻止本回合再产出文件。 */
  private writeBlockReason: string | null = null
  private writesPermanentlyBlocked = false

  constructor(seed: ArtifactFile[]) {
    this.files = new Map(seed.map((f) => [f.path, f.content]))
    this.original = new Map(this.files)
  }

  /** 阻止后续文件改动；可选地丢弃本回合已累积的全部改动。 */
  blockWrites(
    reason: string,
    options: { discardChanges?: boolean; permanent?: boolean } = {}
  ): void {
    if (options.discardChanges) this.discardChanges()
    this.writeBlockReason = reason
    this.writesPermanentlyBlocked ||= options.permanent === true
  }

  /** 解除可恢复的写入闸门；保存失败造成的永久闸门不能由模型绕过。 */
  allowWrites(): void {
    if (this.writesPermanentlyBlocked) return
    this.writeBlockReason = null
  }

  /** 当前回合的文件写入是否仍被闸门阻止。 */
  isWriteBlocked(): boolean {
    return this.writeBlockReason !== null
  }

  private assertWritesAllowed(): void {
    if (this.writeBlockReason) throw new VfsError(this.writeBlockReason)
  }

  private discardChanges(): void {
    this.files.clear()
    for (const [path, content] of this.original) this.files.set(path, content)
    this.touched.clear()
    this.removed.clear()
  }

  /* ---------------------------------------------------------------- */
  /* 读                                                                */
  /* ---------------------------------------------------------------- */

  list(glob?: string): string[] {
    const paths = [...this.files.keys()].sort()
    if (!glob) return paths
    const re = globToRegExp(glob)
    return paths.filter((p) => re.test(p))
  }

  /** 带行数的清单:模型据此判断该不该整份读,而不是读了才知道太大 */
  stats(glob?: string): FileStat[] {
    return this.list(glob).map((path) => {
      const content = this.files.get(path)!
      return { path, lines: toLines(content).length, chars: content.length }
    })
  }

  has(path: string): boolean {
    return this.files.has(path)
  }

  /** 路径在本回合开始时是否存在，供撤回实时预览时区分新建与空文件。 */
  existedAtStart(path: string): boolean {
    return this.original.has(assertPath(path))
  }

  /** 原文,不带行号也不截断。给 check_syntax 这类内部消费者用,不直接喂模型 */
  raw(path: string): { path: string; content: string } {
    const { key, content } = this.mustGet(path)
    return { path: key, content }
  }

  private mustGet(path: string): { key: string; content: string } {
    const key = assertPath(path)
    const content = this.files.get(key)
    if (content === undefined) {
      throw new VfsError(`文件不存在:${key}。用 list_files 看现有文件,新建文件用 write_file。`)
    }
    return { key, content }
  }

  /**
   * 带行号返回。行号只用于读和描述位置——写一律靠唯一字符串锚点,因为
   * 连续编辑会让行号漂移。
   *
   * 没读到的部分不会悄悄丢掉:尾部会补一份结构大纲,告诉模型剩下的内容
   * 长什么样、在第几行,它可以只回来取需要的那一段。
   */
  read(path: string, startLine?: number, endLine?: number): string {
    const { key, content } = this.mustGet(path)
    if (content === '') return '(空文件)'

    const lines = toLines(content)
    const total = lines.length

    const start = Math.max(1, startLine ?? 1)
    if (start > total) {
      throw new VfsError(`起始行 ${start} 超出文件范围(共 ${total} 行)。`)
    }
    const requestedEnd = endLine ?? total
    const capped = Math.min(requestedEnd, start + MAX_READ_LINES - 1)
    const end = Math.min(total, capped)

    const width = String(end).length
    const body = lines
      .slice(start - 1, end)
      .map((line, i) => `${String(start + i).padStart(width, ' ')}→${clip(line, MAX_LINE_CHARS)}`)
      .join('\n')

    const notes: string[] = []
    if (end < requestedEnd) {
      notes.push(`单次最多读 ${MAX_READ_LINES} 行,已截断到第 ${end} 行。`)
    }
    if (start > 1 || end < total) {
      notes.push(`${key} 共 ${total} 行,当前只看了 ${start}-${end}。`)
      const rest = outlineBetween(outlineOf(key, lines), 1, total).filter(
        (e) => e.line < start || e.line > end
      )
      const outline = renderOutline(rest)
      if (outline) notes.push(`区间之外的结构大纲(只给骨架,取正文请再 read_file):\n${outline}`)
    }

    return notes.length ? `${body}\n\n---\n${notes.join('\n')}` : body
  }

  /** 结构大纲:先看骨架再定位,比整份读便宜一个数量级 */
  outline(path: string): string {
    const { key, content } = this.mustGet(path)
    const lines = toLines(content)
    const rendered = renderOutline(outlineOf(key, lines))
    if (!rendered) {
      return `${key} 共 ${lines.length} 行,这个类型没有可用的结构大纲,请用 read_file 按区间读。`
    }
    return `${key} 共 ${lines.length} 行,结构大纲:\n${rendered}`
  }

  /**
   * 按行列取原文,**不带行号**——取出来可以原样当 edit_file 的
   * old_string 用。search 给出行列,这里精确切片,省掉"读一段再手抄"的
   * 那一步,也顺带绕开了手抄导致的锚点对不上。
   *
   * 行列都是 1 起;列缺省表示整行。
   */
  getRange(
    path: string,
    startLine: number,
    endLine?: number,
    startColumn?: number,
    endColumn?: number
  ): string {
    const { key, content } = this.mustGet(path)
    const lines = toLines(content)
    const total = lines.length

    if (startLine < 1 || startLine > total) {
      throw new VfsError(`起始行 ${startLine} 超出文件范围(${key} 共 ${total} 行)。`)
    }
    const last = Math.min(endLine ?? startLine, total)
    if (last < startLine) {
      throw new VfsError(`结束行 ${last} 不能小于起始行 ${startLine}。`)
    }

    const picked = lines.slice(startLine - 1, last)
    if (startColumn && startColumn > 1) {
      picked[0] = picked[0].slice(startColumn - 1)
    }
    if (endColumn) {
      const lastIndex = picked.length - 1
      const offset = lastIndex === 0 && startColumn && startColumn > 1 ? startColumn - 1 : 0
      picked[lastIndex] = picked[lastIndex].slice(0, Math.max(0, endColumn - offset))
    }
    return picked.join('\n')
  }

  /**
   * 全文搜索。返回命中行及其上下文,模型多数时候靠这个就能定位,不必
   * 打开文件——这是省 token 最直接的一条。
   */
  search(query: string, options: SearchOptions = {}): SearchHit[] {
    if (!query) throw new VfsError('搜索内容不能为空。')

    const limit = Math.min(options.maxResults ?? DEFAULT_SEARCH_RESULTS, MAX_SEARCH_RESULTS)
    const context = Math.max(0, Math.min(options.contextLines ?? 0, 5))
    const flags = options.caseSensitive ? 'g' : 'gi'

    let pattern: RegExp
    try {
      pattern = new RegExp(
        options.regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
        flags
      )
    } catch (err) {
      throw new VfsError(`正则表达式无效:${err instanceof Error ? err.message : String(err)}`)
    }

    const hits: SearchHit[] = []
    for (const path of this.list(options.glob)) {
      const lines = toLines(this.files.get(path)!)
      for (let i = 0; i < lines.length; i++) {
        if (hits.length >= limit) return hits
        pattern.lastIndex = 0
        const match = pattern.exec(lines[i])
        if (!match) continue
        hits.push({
          path,
          line: i + 1,
          column: match.index + 1,
          text: clip(lines[i], MAX_LINE_CHARS),
          before: lines.slice(Math.max(0, i - context), i).map((l) => clip(l, MAX_LINE_CHARS)),
          after: lines.slice(i + 1, i + 1 + context).map((l) => clip(l, MAX_LINE_CHARS))
        })
      }
    }
    return hits
  }

  /* ---------------------------------------------------------------- */
  /* 写                                                                */
  /* ---------------------------------------------------------------- */

  /** 整份写入:新建文件,或改动幅度过大时的重写 */
  write(path: string, content: string): VfsPatch {
    this.assertWritesAllowed()
    const key = assertPath(path)
    this.files.set(key, content)
    this.touched.add(key)
    this.removed.delete(key)
    // oldText 留空:渲染层直接整份替换,不必为全文重写做锚点匹配
    return { path: key, oldText: '', newText: content }
  }

  /** 局部替换。锚点必须逐字符一致且(默认)唯一 */
  edit(path: string, oldText: string, newText: string, replaceAll = false): VfsPatch {
    this.assertWritesAllowed()
    const { key, content } = this.mustGetForEdit(path)
    const next = applyEdit(content, { oldText, newText, replaceAll })
    this.files.set(key, next.content)
    this.touched.add(key)
    this.removed.delete(key)
    return { path: key, oldText, newText, replaceAll: next.multi }
  }

  /**
   * 同一个文件里的多处编辑,按顺序施加,**全成或全不成**。
   *
   * 任何一处锚点对不上就整体回滚并报出是第几处——半成品状态比失败更难
   * 收拾,模型也说不清自己改到哪了。
   */
  multiEdit(path: string, edits: EditSpec[]): VfsPatch[] {
    this.assertWritesAllowed()
    if (edits.length === 0) throw new VfsError('edits 不能为空。')
    const { key, content } = this.mustGetForEdit(path)

    let working = content
    const patches: VfsPatch[] = []
    for (const [index, spec] of edits.entries()) {
      try {
        const result = applyEdit(working, spec)
        working = result.content
        patches.push({
          path: key,
          oldText: spec.oldText,
          newText: spec.newText,
          replaceAll: result.multi
        })
      } catch (err) {
        const reason = err instanceof VfsError ? err.message : String(err)
        throw new VfsError(`第 ${index + 1} 处编辑失败(其余改动已一并撤销):${reason}`)
      }
    }

    this.files.set(key, working)
    this.touched.add(key)
    this.removed.delete(key)
    return patches
  }

  /**
   * 重命名 / 移动。
   *
   * 单独成一个操作,而不是让模型 write 一遍再 delete:后者要把整份内容
   * 再吐一次,一个几百行的文件就是白烧几千 token,而这个操作压根不需要
   * 内容参与。
   */
  move(from: string, to: string): { removed: string; patch: VfsPatch } {
    this.assertWritesAllowed()
    const source = this.mustGetForEdit(from)
    const target = assertPath(to)
    if (source.key === target) throw new VfsError('源路径与目标路径相同。')
    if (this.files.has(target)) {
      throw new VfsError(`目标路径 ${target} 已存在。先 delete_file,或换一个名字。`)
    }
    this.remove(source.key)
    return { removed: source.key, patch: this.write(target, source.content) }
  }

  /** 复制。同样不需要内容过一遍模型 */
  copy(from: string, to: string): VfsPatch {
    this.assertWritesAllowed()
    const source = this.mustGetForEdit(from)
    const target = assertPath(to)
    if (source.key === target) throw new VfsError('源路径与目标路径相同。')
    if (this.files.has(target)) {
      throw new VfsError(`目标路径 ${target} 已存在。先 delete_file,或换一个名字。`)
    }
    return this.write(target, source.content)
  }

  /**
   * 把一个文件退回本回合开始时的样子。
   *
   * 模型把文件改坏了想重来时的逃生口——没有它只能靠重写整份内容,而"重写
   * 一份自己刚弄坏的文件"恰恰是最容易越描越黑的操作。
   */
  revert(path: string): { patch: VfsPatch | null; deleted: string | null } {
    this.assertWritesAllowed()
    const key = assertPath(path)
    const wasTouched = this.touched.has(key)
    const wasRemoved = this.removed.has(key)
    if (!wasTouched && !wasRemoved) {
      throw new VfsError(`${key} 本回合没有改动过,无需撤销。`)
    }

    const origin = this.original.get(key)
    this.touched.delete(key)
    this.removed.delete(key)

    if (origin === undefined) {
      // 本回合新建的:撤销就是让它不存在
      this.files.delete(key)
      return { patch: null, deleted: key }
    }
    this.files.set(key, origin)
    return { patch: { path: key, oldText: '', newText: origin }, deleted: null }
  }

  /** 返回归一化后的路径,供事件发送 */
  remove(path: string): string {
    this.assertWritesAllowed()
    const key = assertPath(path)
    if (!this.files.has(key)) {
      throw new VfsError(`文件不存在:${key},无需删除。`)
    }
    this.files.delete(key)
    this.touched.delete(key)
    this.removed.add(key)
    return key
  }

  /**
   * 事务:整段跑通才生效,中途抛错就把文件、改动集一起回滚。
   *
   * apply_patch 要跨多个文件,改到第三个文件才发现锚点对不上时,前两个
   * 文件不该留在半成品状态——模型自己也说不清改到哪了。调用方还要把
   * patch 事件攒着,等事务成了再发,否则渲染层已经画上去了。
   */
  transact<T>(run: () => T): T {
    this.assertWritesAllowed()
    const files = new Map(this.files)
    const touched = new Set(this.touched)
    const removed = new Set(this.removed)
    try {
      return run()
    } catch (err) {
      this.files.clear()
      for (const [k, v] of files) this.files.set(k, v)
      this.touched.clear()
      for (const k of touched) this.touched.add(k)
      this.removed.clear()
      for (const k of removed) this.removed.add(k)
      throw err
    }
  }

  private mustGetForEdit(path: string): { key: string; content: string } {
    const key = assertPath(path)
    const content = this.files.get(key)
    if (content === undefined) {
      throw new VfsError(`文件不存在:${key}。新建文件请用 write_file。`)
    }
    return { key, content }
  }

  /* ---------------------------------------------------------------- */
  /* 回合产出                                                          */
  /* ---------------------------------------------------------------- */

  /**
   * 灌入 markers 协议(FileStreamParser)的产出。两条协议路线共用同一个
   * 落库出口,chat-service 的 finalize 只认 VFS 一个来源。
   */
  validateIngestPaths(writes: Map<string, string>, deletes: Set<string>): void {
    for (const path of deletes) assertPath(path)
    for (const path of writes.keys()) assertPath(path)
  }

  ingest(writes: Map<string, string>, deletes: Set<string>): void {
    // 这一路的路径来自模型自由书写的标记,非法的直接丢弃而不是抛——
    // 一个坏路径不该让整回合的产出都落不了库
    const validDeletes = [...deletes].flatMap((path) => {
      const key = safePath(path)
      return key ? [key] : []
    })
    const validWrites = [...writes].flatMap(([path, content]) => {
      const key = safePath(path)
      return key ? [[key, content] as const] : []
    })
    // markers 路即使没有文件标记也会走一次 ingest；空输入不改变 VFS，
    // 因此不能把首次确认回合误判成一次被拒绝的写入。
    if (validDeletes.length === 0 && validWrites.length === 0) return
    this.assertWritesAllowed()

    for (const key of validDeletes) {
      this.files.delete(key)
      this.touched.delete(key)
      this.removed.add(key)
    }
    for (const [key, content] of validWrites) {
      this.files.set(key, content)
      this.touched.add(key)
      this.removed.delete(key)
    }
  }

  /** 本回合的改动明细(相对回合开始时的快照),给 diff 用 */
  changes(): { path: string; before: string; after: string | null }[] {
    const out: { path: string; before: string; after: string | null }[] = []
    for (const path of [...this.touched].sort()) {
      out.push({ path, before: this.original.get(path) ?? '', after: this.files.get(path)! })
    }
    for (const path of [...this.removed].sort()) {
      out.push({ path, before: this.original.get(path) ?? '', after: null })
    }
    return out
  }

  get hasChanges(): boolean {
    return this.touched.size > 0 || this.removed.size > 0
  }

  /** 与 FileStreamParser.files 同形 */
  get writes(): Map<string, string> {
    const out = new Map<string, string>()
    for (const path of this.touched) out.set(path, this.files.get(path)!)
    return out
  }

  /** 与 FileStreamParser.deleted 同形 */
  get deletes(): Set<string> {
    return new Set(this.removed)
  }
}

/** 单处替换的公共实现,edit / multiEdit 共用 */
function applyEdit(content: string, spec: EditSpec): { content: string; multi: boolean } {
  const { oldText, newText, replaceAll = false } = spec
  if (!oldText) {
    throw new VfsError('old_string 不能为空。整份写入请用 write_file。')
  }
  if (oldText === newText) {
    throw new VfsError('新旧内容相同,无需编辑。')
  }

  const hits = countOccurrences(content, oldText)
  if (hits === 0) {
    throw new VfsError(
      '未找到匹配内容。请先 search_files 或 read_file 确认原文(注意缩进与空行),' +
        'old_string 需与原文逐字符一致;也可以用 get_range 按行列把原文精确取出来。'
    )
  }
  if (hits > 1 && !replaceAll) {
    throw new VfsError(
      `匹配到 ${hits} 处。请扩大 old_string 包含更多上下文行以保证唯一,或传 replace_all: true。`
    )
  }

  return {
    content: replaceAll
      ? replaceEvery(content, oldText, newText)
      : replaceFirst(content, oldText, newText),
    multi: replaceAll && hits > 1
  }
}
