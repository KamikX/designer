import { VfsError } from './vfs-error'

/**
 * V4A 补丁格式解析(OpenAI apply_patch / VS Code `apply_patch` 同款)。
 *
 * ```
 * *** Begin Patch
 * *** Update File: css/style.css
 * @@
 *  .hero {
 * -  color: red;
 * +  color: #1677ff;
 *  }
 * *** Add File: css/theme.css
 * +:root { --brand: #1677ff; }
 * *** Delete File: css/old.css
 * *** End Patch
 * ```
 *
 * 选它而不是标准 unified diff,是因为它**不带行号**——行号在连续编辑中
 * 会漂移,而模型是照着几步之前读到的内容写补丁的。V4A 靠上下文行定位,
 * 跟 edit_file 的锚点思路是同一套,落到实现上每个 hunk 就是一次
 * `edit(before, after)`。
 *
 * 一次调用改多个文件的多处,是这套工具里最省 token 的一个:工具循环每
 * 多走一步,整个对话历史就要重发一遍。
 */

export type PatchOp =
  | { kind: 'update'; path: string; hunks: { before: string; after: string }[] }
  | { kind: 'add'; path: string; content: string }
  | { kind: 'delete'; path: string }

const BEGIN = '*** Begin Patch'
const END = '*** End Patch'
const UPDATE = /^\*\*\* Update File:\s*(.+?)\s*$/
const ADD = /^\*\*\* Add File:\s*(.+?)\s*$/
const DELETE = /^\*\*\* Delete File:\s*(.+?)\s*$/
const EOF_MARKER = /^\*\*\* End of File\s*$/
const HUNK_HEADER = /^@@/

interface Section {
  kind: 'update' | 'add' | 'delete'
  path: string
  body: string[]
}

export function parsePatch(text: string): PatchOp[] {
  const lines = text.replace(/\r\n/g, '\n').split('\n')

  const start = lines.findIndex((l) => l.trim() === BEGIN)
  if (start < 0) {
    throw new VfsError(`补丁必须以 "${BEGIN}" 开头。`)
  }
  const stop = lines.findIndex((l, i) => i > start && l.trim() === END)
  if (stop < 0) {
    throw new VfsError(`补丁必须以 "${END}" 结尾。`)
  }

  const sections: Section[] = []
  for (const line of lines.slice(start + 1, stop)) {
    const update = line.match(UPDATE)
    const add = line.match(ADD)
    const del = line.match(DELETE)
    if (update) {
      sections.push({ kind: 'update', path: update[1], body: [] })
      continue
    }
    if (add) {
      sections.push({ kind: 'add', path: add[1], body: [] })
      continue
    }
    if (del) {
      sections.push({ kind: 'delete', path: del[1], body: [] })
      continue
    }
    if (EOF_MARKER.test(line)) continue
    if (sections.length === 0) {
      if (line.trim() === '') continue
      throw new VfsError(
        '补丁里出现了不属于任何文件的内容。每段之前要先写 "*** Update File: 路径"。'
      )
    }
    sections[sections.length - 1].body.push(line)
  }

  if (sections.length === 0) {
    throw new VfsError('补丁是空的,没有任何 Update / Add / Delete 段。')
  }

  return sections.map(toOp)
}

function toOp(section: Section): PatchOp {
  if (section.kind === 'delete') return { kind: 'delete', path: section.path }

  if (section.kind === 'add') {
    const content = section.body
      .filter((l) => l.trim() !== '' || l.startsWith('+'))
      .map((l) => {
        if (!l.startsWith('+')) {
          throw new VfsError(
            `Add File 段(${section.path})里的每一行都要以 "+" 开头,发现:${JSON.stringify(l)}`
          )
        }
        return l.slice(1)
      })
      .join('\n')
    return { kind: 'add', path: section.path, content: content ? `${content}\n` : '' }
  }

  return { kind: 'update', path: section.path, hunks: toHunks(section) }
}

function toHunks(section: Section): { before: string; after: string }[] {
  // @@ 行分段;第一个 @@ 之前的内容也算一段(模型经常省掉开头的 @@)
  const groups: string[][] = [[]]
  for (const line of section.body) {
    if (HUNK_HEADER.test(line)) {
      groups.push([])
      continue
    }
    groups[groups.length - 1].push(line)
  }

  const hunks = groups
    .map((group) => toHunk(section.path, group))
    .filter((h): h is { before: string; after: string } => h !== null)

  if (hunks.length === 0) {
    throw new VfsError(`Update File 段(${section.path})里没有任何改动行。`)
  }
  return hunks
}

function toHunk(path: string, group: string[]): { before: string; after: string } | null {
  // 去掉段首尾的空行:它们是格式排版,不是文件内容
  const body = [...group]
  while (body.length && body[0] === '') body.shift()
  while (body.length && body[body.length - 1] === '') body.pop()
  if (body.length === 0) return null

  const before: string[] = []
  const after: string[] = []
  let hasAnchor = false

  for (const line of body) {
    // 模型常把纯空的上下文行写成真空行(尾随空格被吃掉),按上下文处理
    const marker = line === '' ? ' ' : line[0]
    const text = line === '' ? '' : line.slice(1)
    switch (marker) {
      case ' ':
        before.push(text)
        after.push(text)
        hasAnchor = true
        break
      case '-':
        before.push(text)
        hasAnchor = true
        break
      case '+':
        after.push(text)
        break
      default:
        throw new VfsError(
          `Update File 段(${path})里的行必须以空格 / "-" / "+" 开头,发现:${JSON.stringify(line)}`
        )
    }
  }

  if (!hasAnchor) {
    throw new VfsError(
      `Update File 段(${path})里有一处只有新增行、没有任何上下文行,定位不到插入位置。` +
        '请带上前后各几行原文作为上下文(以空格开头)。'
    )
  }
  if (before.join('\n') === after.join('\n')) return null

  return { before: before.join('\n'), after: after.join('\n') }
}
