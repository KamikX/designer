import { text as appText } from '../i18n'
import { createHash } from 'node:crypto'
import { safePath } from './session-vfs'
import { VfsError } from './vfs-error'

/**
 * 工具追踪脱敏:决定一次工具调用有哪些元数据可以落进 tool_runs。
 *
 * ## 为什么是显式白名单注册而不是"自动挑安全字段"
 *
 * 工具入参里什么都可能有:整份文件、绝对路径、搜索词、用户答案、密钥。
 * 任何"看起来安全就存"的启发式迟早存进不该存的东西——低熵口令连熵检测
 * 都过不了。所以反着来:没注册的工具**什么目标都不保存**,注册过的也只
 * 产出该工具族被明确允许的那几个字段。
 *
 * 所有出口字符串再过一遍 redactTraceText 作为第二道防线。
 */

export interface ToolTraceMeta {
  /** 脱敏后的目标摘要;未注册工具恒为 null */
  targetSummary: string | null
}

type Sanitizer = (input: Record<string, unknown>) => string | null

function str(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key]
  return typeof value === 'string' && value ? value : undefined
}

/** 设计稿工具:只认真正通过 VFS 路径校验的相对路径 */
function designPath(input: Record<string, unknown>): string | null {
  const path = str(input, 'path')
  if (!path) return null
  return safePath(path)
}

/** 查询类:只保留长度,一个字都不留 */
function queryLength(input: Record<string, unknown>): string | null {
  const query = str(input, 'query')
  return query ? appText('ai.toolTraceSanitizer.queryCharacters', query.length) : null
}

/**
 * 本地路径:不可逆哈希 + 扩展名。哈希让"同一个文件反复失败"在诊断里
 * 可关联,扩展名让人知道是什么类型,但绝对路径/相对路径/basename 都不出现。
 */
function localPathHash(input: Record<string, unknown>): string | null {
  const path = str(input, 'path') ?? str(input, 'dir')
  if (!path) return null
  const hash = createHash('sha256').update(path).digest('hex').slice(0, 12)
  const extMatch = /\.([A-Za-z0-9]{1,8})$/.exec(path)
  return extMatch ? `${hash}.${extMatch[1]}` : hash
}

/** URL 只保留 host:去了哪个站可以看,去干了什么不行 */
function urlHost(input: Record<string, unknown>): string | null {
  const url = str(input, 'url')
  if (!url) return null
  try {
    return new URL(url).host
  } catch {
    return null
  }
}

function askUserCounts(input: Record<string, unknown>): string | null {
  const questions = Array.isArray(input.questions) ? input.questions : []
  const optionCount = questions.reduce((sum: number, q) => {
    const options = q && typeof q === 'object' ? (q as Record<string, unknown>).options : null
    return sum + (Array.isArray(options) ? options.length : 0)
  }, 0)
  return appText('ai.toolTraceSanitizer.questionsOptions', questions.length, optionCount)
}

/**
 * 白名单注册表。VFS 工具族共享 designPath;这里没有条目的工具走默认
 * sanitizer(无目标)。新工具想进诊断必须在这里显式登记。
 */
const SANITIZERS: Record<string, Sanitizer> = {
  // 设计稿 VFS 工具
  list_files: designPath,
  outline_file: designPath,
  read_file: designPath,
  get_range: designPath,
  capture_range: designPath,
  edit_file: designPath,
  multi_edit_file: designPath,
  apply_patch: designPath,
  apply_string_edits: designPath,
  write_file: designPath,
  move_file: designPath,
  copy_file: designPath,
  delete_file: designPath,
  diff_changes: designPath,
  check_syntax: designPath,
  revert_file: designPath,
  search_files: queryLength,
  // 本地 workspace 工具
  list_local_dir: localPathHash,
  check_local_path: localPathHash,
  find_local_files: localPathHash,
  search_local: queryLength,
  read_local_file: localPathHash,
  read_local_document: localPathHash,
  read_document_images: localPathHash,
  // 联网
  web_search: queryLength,
  web_fetch: urlHost,
  browser_open: urlHost,
  // 技能与提问
  activate_skill: (input) => str(input, 'name') ?? null,
  ask_user: askUserCounts
}

export function sanitizeToolTrace(
  toolName: string,
  input: unknown,
  opts?: { mcp?: boolean }
): ToolTraceMeta {
  // MCP:server/tool 已编码在工具键名里,字段值一个都不看
  if (opts?.mcp) return { targetSummary: redactTraceText(toolName) }

  const sanitizer = SANITIZERS[toolName]
  if (!sanitizer || !input || typeof input !== 'object') return { targetSummary: null }
  const target = sanitizer(input as Record<string, unknown>)
  return { targetSummary: target ? redactTraceText(target) : null }
}

/**
 * 错误 → 固定码。provider 和未知工具的原始 message/body 永不落库,
 * 可落库的只有这里映射出来的枚举值。
 */
export function mapToolErrorCode(error: unknown): string {
  if (error && typeof error === 'object') {
    const status = (error as { statusCode?: unknown }).statusCode
    if (typeof status === 'number') {
      if (status === 429) return 'UPSTREAM_RATE_LIMITED'
      if (status >= 500) return 'UPSTREAM_ERROR'
      if (status >= 400) return 'UPSTREAM_REQUEST_REJECTED'
    }
  }
  // VfsError 的 message 是给模型的指引,可能引用用户内容,同样不落库
  if (error instanceof VfsError) return 'TOOL_EXECUTION_FAILED'
  return 'TOOL_EXECUTION_FAILED'
}

/** 常见凭证形态。低熵口令靠白名单挡,这里只兜高辨识度的格式化密钥 */
const CREDENTIAL_PATTERNS = [
  /sk-[A-Za-z0-9_-]{8,}/g,
  /ghp_[A-Za-z0-9]{8,}/g,
  /xox[a-z]-[A-Za-z0-9-]{8,}/g,
  /AKIA[A-Z0-9]{12,}/g,
  /Bearer\s+\S+/g,
  /eyJ[A-Za-z0-9_-]{10,}[^\s]*/g,
  /\b[A-Fa-f0-9]{32,}\b/g
]

/**
 * 第二道防线:对所有将要落库的摘要文本打码路径、URL、邮箱与凭证,
 * 并截断到 240 字符。第一道(白名单)漏了什么,这里最后兜一次。
 */
export function redactTraceText(text: string): string {
  let out = text
  for (const pattern of CREDENTIAL_PATTERNS)
    out = out.replace(pattern, appText('ai.toolTraceSanitizer.credential'))
  // URL 整体打码(host 在白名单阶段已单独提取,这里出现的都是漏网的)
  out = out.replace(/https?:\/\/\S+/g, '[URL]')
  out = out.replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, appText('ai.toolTraceSanitizer.email'))
  // 绝对路径:*nix 两级以上、Windows 盘符路径
  out = out.replace(
    /(?:^|[\s("'`])\/(?:[\w.@~-]+\/)+[\w.@~-]+/g,
    appText('ai.toolTraceSanitizer.path')
  )
  out = out.replace(
    /[A-Za-z]:\\(?:[^\\\s]+\\)*[^\\\s]*/g,
    appText('ai.toolTraceSanitizer.pathText')
  )
  return out.slice(0, 240)
}
