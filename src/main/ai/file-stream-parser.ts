/**
 * 流式解析 <antdFile> 标记协议的状态机。
 *
 * 协议(见 prompts/protocol.ts):
 *   <antdFile path="src/App.vue">      ← 标记独占一行
 *   ...文件原文...
 *   </antdFile>                        ← 独占一行
 *   <antdDelete path="old.css" />      ← 独占一行
 *
 * 选自定义标签而不是 markdown 围栏,是因为设计稿内容自己就带 ``` 围栏
 * (html 里嵌示例代码),会撞;标签名足够独特,正文里出现的概率可忽略。
 *
 * 设计要点:
 * - 按行缓冲:标记只在完整行上识别,跨 chunk 撕裂天然正确。
 * - 正文(text 态)的未完行会尽快放行——只有当它还可能是标记前缀时才
 *   压住,保证打字机效果不卡顿。
 * - 容错:流结束时文件未闭合,自动补 file-end(网络中断/模型忘了闭合,
 *   已生成的内容照样可用)。
 *
 * 纯函数状态机,不碰 IO,方便单测。
 */

export type ParserEvent =
  | { type: 'text'; text: string }
  | { type: 'file-start'; path: string }
  | { type: 'file-delta'; path: string; text: string }
  | { type: 'file-end'; path: string }
  | { type: 'file-delete'; path: string }

const FILE_START = /^\s*<antdFile\s+path="([^"]+)"\s*>\s*$/
const FILE_END = /^\s*<\/antdFile\s*>\s*$/
const FILE_DELETE = /^\s*<antdDelete\s+path="([^"]+)"\s*\/>\s*$/

/** 未完行是否还可能长成标记行(是则先压着不放行) */
function mayBecomeMarker(partial: string): boolean {
  const t = partial.trimStart()
  if (t.length === 0) return true
  return (
    '<antdFile'.startsWith(t) ||
    t.startsWith('<antdFile') ||
    '</antdFile>'.startsWith(t) ||
    t.startsWith('</antdFile') ||
    '<antdDelete'.startsWith(t) ||
    t.startsWith('<antdDelete')
  )
}

export class FileStreamParser {
  /** 累计的文件内容(path → 全文),流结束后取用 */
  readonly files = new Map<string, string>()
  /** 被 <antdDelete> 标记删除的路径 */
  readonly deleted = new Set<string>()
  /** 解说正文(不含文件体)的累计 */
  narration = ''

  private pending = ''
  /** pending 中已作为 text 放行的前缀长度(仅 text 态使用) */
  private released = 0
  private currentPath: string | null = null
  private currentLines: string[] = []

  push(chunk: string): ParserEvent[] {
    const events: ParserEvent[] = []
    this.pending += chunk

    let newlineAt: number
    while ((newlineAt = this.pending.indexOf('\n')) >= 0) {
      const line = this.pending.slice(0, newlineAt)
      this.pending = this.pending.slice(newlineAt + 1)
      this.consumeLine(line, events)
    }

    // 处理未完行:text 态下尽快放行,file 态下一律压到成行
    if (this.currentPath == null && !mayBecomeMarker(this.pending)) {
      const fresh = this.pending.slice(this.released)
      if (fresh) {
        events.push({ type: 'text', text: fresh })
        this.narration += fresh
        this.released = this.pending.length
      }
    }
    return events
  }

  /** 流结束时调用:冲掉残余,未闭合的文件自动收尾 */
  finish(): ParserEvent[] {
    const events: ParserEvent[] = []
    if (this.pending) {
      const line = this.pending
      this.pending = ''
      if (this.currentPath == null) {
        // 末行也可能是完整标记(模型最后没输出换行)
        const start = line.match(FILE_START)
        const del = line.match(FILE_DELETE)
        if (start) {
          this.currentPath = start[1]
          this.currentLines = []
          events.push({ type: 'file-start', path: start[1] })
        } else if (del) {
          this.deleted.add(del[1])
          this.files.delete(del[1])
          events.push({ type: 'file-delete', path: del[1] })
        } else {
          // 与流中放行不同:结尾没有换行就不补,原样透传
          const fresh = line.slice(this.released)
          if (fresh) {
            events.push({ type: 'text', text: fresh })
            this.narration += fresh
          }
        }
      } else if (FILE_END.test(line)) {
        this.closeFile(events)
      } else {
        this.currentLines.push(line)
        events.push({ type: 'file-delta', path: this.currentPath, text: line })
      }
      this.released = 0
    }
    if (this.currentPath != null) {
      this.closeFile(events)
    }
    return events
  }

  get hasChanges(): boolean {
    return this.files.size > 0 || this.deleted.size > 0
  }

  private consumeLine(line: string, events: ParserEvent[]): void {
    // 该行此前可能已有前缀作为 text 放行,只处理剩余部分
    const fresh = this.currentPath == null ? line.slice(this.released) : line
    this.released = 0

    if (this.currentPath == null) {
      const start = line.match(FILE_START)
      if (start) {
        this.currentPath = start[1]
        this.currentLines = []
        events.push({ type: 'file-start', path: start[1] })
        return
      }
      const del = line.match(FILE_DELETE)
      if (del) {
        this.deleted.add(del[1])
        this.files.delete(del[1])
        events.push({ type: 'file-delete', path: del[1] })
        return
      }
      if (fresh || line.length === 0) {
        const text = `${fresh}\n`
        events.push({ type: 'text', text })
        this.narration += text
      } else {
        // fresh 为空但整行非空:整行已放行过,只补换行
        events.push({ type: 'text', text: '\n' })
        this.narration += '\n'
      }
      return
    }

    if (FILE_END.test(line)) {
      this.closeFile(events)
      return
    }
    this.currentLines.push(line)
    events.push({ type: 'file-delta', path: this.currentPath, text: `${line}\n` })
  }

  private closeFile(events: ParserEvent[]): void {
    const path = this.currentPath!
    this.files.set(path, `${this.currentLines.join('\n')}\n`)
    this.deleted.delete(path)
    this.currentPath = null
    this.currentLines = []
    events.push({ type: 'file-end', path })
  }
}
