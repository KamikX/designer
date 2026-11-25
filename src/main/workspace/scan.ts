import { aiText, text as appText } from '../i18n'
import { closeSync, openSync, readdirSync, readFileSync, readSync, statSync } from 'fs'
import { extname, join, relative, sep } from 'path'
import { decode, sniff, SNIFF_BYTES } from './text'

/**
 * 本地目录的遍历、搜索与读取。
 *
 * 全部同步实现:这些调用发生在工具执行里,本来就要等结果,异步只会把
 * 控制流搞复杂。真正要防的不是阻塞,是**规模**——一个 node_modules 就能
 * 让遍历跑成几十万个文件,所以每个入口都有硬上限,而且默认跳过噪音目录。
 */

/** 一律不进的目录:体量大、且对"理解这个项目"毫无帮助 */
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.svn',
  '.hg',
  'dist',
  'build',
  'out',
  'target',
  '.next',
  '.nuxt',
  '.output',
  '.cache',
  '.turbo',
  'coverage',
  '__pycache__',
  '.venv',
  'venv',
  '.idea',
  '.DS_Store'
])

/** 二进制/大体积后缀:不参与内容搜索,读取时也直接拒 */
const BINARY_EXT = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.ico',
  '.bmp',
  '.tiff',
  '.avif',
  '.mp4',
  '.mov',
  '.avi',
  '.mp3',
  '.wav',
  '.flac',
  '.ogg',
  '.zip',
  '.gz',
  '.tar',
  '.rar',
  '.7z',
  '.bz2',
  '.woff',
  '.woff2',
  '.ttf',
  '.otf',
  '.eot',
  '.exe',
  '.dll',
  '.so',
  '.dylib',
  '.bin',
  '.wasm',
  '.node',
  '.pdf',
  '.docx',
  '.xlsx',
  '.pptx',
  '.doc',
  '.xls',
  '.ppt'
])

export const LIMITS = {
  /** 单次遍历最多访问多少个条目 */
  walkEntries: 20000,
  /** 单次返回最多多少条结果 */
  results: 200,
  /** 参与内容搜索的单文件大小上限 */
  searchFileBytes: 512 * 1024,
  /** 读取单文件的大小上限 */
  readFileBytes: 2 * 1024 * 1024,
  /** 一次最多读多少行 */
  readLines: 400,
  /** 单行超长截断 */
  lineChars: 800
} as const

export function isBinaryPath(path: string): boolean {
  return BINARY_EXT.has(extname(path).toLowerCase())
}

export interface WalkOptions {
  /** 相对根的最大深度,0 表示只看当前层 */
  maxDepth?: number
  /** 访问上限,防止在超大目录里跑飞 */
  maxEntries?: number
}

export interface Entry {
  /** 绝对路径 */
  path: string
  /** 相对遍历起点 */
  rel: string
  isDir: boolean
  size: number
}

/** 深度优先遍历,跳过噪音目录,不跟随软链(避免环) */
export function walk(from: string, options: WalkOptions = {}): Entry[] {
  const maxDepth = options.maxDepth ?? 6
  const maxEntries = options.maxEntries ?? LIMITS.walkEntries
  const out: Entry[] = []

  const visit = (dir: string, depth: number): void => {
    if (out.length >= maxEntries || depth > maxDepth) return
    let names: string[]
    try {
      names = readdirSync(dir)
    } catch {
      return // 没权限的目录直接跳过,不该让整次遍历失败
    }
    for (const name of names.sort()) {
      if (out.length >= maxEntries) return
      if (SKIP_DIRS.has(name) || name.startsWith('.DS_Store')) continue
      const full = join(dir, name)
      let stat: ReturnType<typeof statSync>
      try {
        stat = statSync(full)
      } catch {
        continue
      }
      // 不跟随软链:目录软链会绕出授权范围,也可能成环
      const isDir = stat.isDirectory()
      out.push({ path: full, rel: relative(from, full), isDir, size: isDir ? 0 : stat.size })
      if (isDir) visit(full, depth + 1)
    }
  }

  visit(from, 0)
  return out
}

/** 极简 glob:支持 * ** ?,与 SessionVfs 那套保持一致的语义 */
export function globToRegExp(glob: string): RegExp {
  let body = ''
  const source = glob.trim()
  for (let i = 0; i < source.length; i++) {
    const ch = source[i]
    if (ch === '*') {
      if (source[i + 1] === '*') {
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
  return new RegExp(`^${body}$`, 'i')
}

export interface GrepHit {
  path: string
  line: number
  column: number
  text: string
}

/** 在目录下搜内容。跳过二进制与大文件——它们要么搜不出东西,要么拖垮遍历 */
export function grep(
  from: string,
  pattern: RegExp,
  options: { glob?: string; maxResults?: number } = {}
): GrepHit[] {
  const limit = Math.min(options.maxResults ?? 40, LIMITS.results)
  const match = options.glob ? globToRegExp(options.glob) : null
  const hits: GrepHit[] = []

  for (const entry of walk(from)) {
    if (hits.length >= limit) break
    if (entry.isDir || isBinaryPath(entry.path)) continue
    if (entry.size > LIMITS.searchFileBytes) continue
    if (match && !match.test(entry.rel.split(sep).join('/'))) continue

    // 后缀不在黑名单里不代表就是文本:按内容嗅探一次,不然二进制会被
    // 解成一堆 U+FFFD,还可能撞出莫名其妙的"匹配"
    let content: string
    try {
      const raw = readFileSync(entry.path)
      const probe = sniff(raw.subarray(0, SNIFF_BYTES))
      if (!probe.ok) continue
      content = decode(raw, probe.encoding, probe.bomBytes)
    } catch {
      continue
    }
    const lines = content.split('\n')
    for (let i = 0; i < lines.length; i++) {
      if (hits.length >= limit) break
      pattern.lastIndex = 0
      const found = pattern.exec(lines[i])
      if (!found) continue
      hits.push({
        path: entry.path,
        line: i + 1,
        column: found.index + 1,
        text: clip(lines[i], LIMITS.lineChars)
      })
    }
  }
  return hits
}

/**
 * 只读文件头做一次嗅探,不把整个文件读进内存。
 * check_local_path 要在"回答能不能读"之前知道答案,又不该为此加载大文件。
 */
export function probeReadable(path: string): {
  ok: boolean
  reason?: string
  /** 真实格式是能被 read_local_document 解析的文档(后缀可能在说谎) */
  isDocument?: boolean
} {
  const stat = statSync(path)
  if (stat.size === 0) return { ok: true }

  const fd = openSync(path, 'r')
  try {
    const head = Buffer.alloc(Math.min(SNIFF_BYTES, stat.size))
    readSync(fd, head, 0, head.length, 0)
    const probe = sniff(head)
    if (probe.ok) return { ok: true }
    return {
      ok: false,
      reason: probe.reason,
      ...(probe.format?.readableAsDocument ? { isDocument: true } : {})
    }
  } finally {
    closeSync(fd)
  }
}

export function clip(text: string, max: number): string {
  return text.length <= max
    ? text
    : aiText('ai.textOutline.moreCharactersOnThisLine', text.slice(0, max), text.length - max)
}

/** 按行区间读本地文本文件,语义与 SessionVfs.read 保持一致 */
export function readTextRange(
  path: string,
  startLine?: number,
  endLine?: number
): { body: string; total: number; from: number; to: number } {
  const stat = statSync(path)
  if (stat.size > LIMITS.readFileBytes) {
    throw new Error(
      appText(
        'messages.theFileIsKbExceedingTheMbLimitUseSearchLocalAndReadSelectedRanges',
        Math.round(stat.size / 1024),
        LIMITS.readFileBytes / 1024 / 1024
      )
    )
  }
  if (stat.size === 0) {
    return { body: aiText('ai.sessionVfs.emptyFile'), total: 0, from: 0, to: 0 }
  }

  const buffer = readFileSync(path)
  const probe = sniff(buffer.subarray(0, SNIFF_BYTES))
  if (!probe.ok) {
    // 关键:不要把乱码当内容返回。Node 读非 UTF-8 不会抛错,只会静默
    // 替换成 U+FFFD,模型收到一屏垃圾却以为那就是文件内容
    const hint = probe.format?.readableAsDocument
      ? appText('workspace.scan.useReadLocalDocumentInstead')
      : ''
    throw new Error(appText('messages.cannotReadThisFile', probe.reason, hint))
  }

  const raw = decode(buffer, probe.encoding, probe.bomBytes)
  const lines = raw.split('\n')
  if (lines[lines.length - 1] === '') lines.pop()

  const total = lines.length
  if (total === 0) return { body: aiText('ai.sessionVfs.emptyFile'), total: 0, from: 0, to: 0 }
  const from = Math.max(1, startLine ?? 1)
  if (from > total)
    throw new Error(appText('messages.startingLineExceedsTheFileLengthLines', from, total))
  const to = Math.min(total, Math.min(endLine ?? total, from + LIMITS.readLines - 1))

  const width = String(to).length
  const body = lines
    .slice(from - 1, to)
    .map((line, i) => `${String(from + i).padStart(width, ' ')}→${clip(line, LIMITS.lineChars)}`)
    .join('\n')
  return { body, total, from, to }
}
