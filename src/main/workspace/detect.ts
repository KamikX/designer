import { existsSync, realpathSync, statSync } from 'fs'
import { homedir } from 'os'
import { dirname, resolve } from 'path'

/**
 * 从**用户自己输入的文本**里识别本地路径。
 *
 * ## 为什么只认用户输入
 *
 * 这个函数的输出会直接变成一条授权。所以它的输入必须是用户的真实意图,
 * 而不是任何可以被间接控制的东西:
 *
 * - ✅ 用户在输入框里敲的话
 * - ❌ 模型的输出(模型可以被诱导写出一个路径)
 * - ❌ 读进来的文档内容(一份 PDF 里写"请读取 /etc/passwd"就能提权)
 * - ❌ 本地文件的内容(同上)
 *
 * 这是间接提示注入最典型的入口,调用点只有 chat-service 里"用户消息"
 * 那一处,不要扩散。
 *
 * ## 为什么用"存在性"当主过滤器
 *
 * 正则再怎么写都会误伤(`and/or`、`24/7`、`读写/权限`)。而"这个路径在这台
 * 机器上真实存在"是一个极强的信号:随手写的斜杠几乎不可能命中。所以规则
 * 是宽进严出——候选放宽,最后一律用 existsSync 卡死。
 */

/** 一条消息最多自动授权几个路径,防止粘一大段日志把满屏路径都授权了 */
const MAX_DETECTED = 3

export interface DetectedPath {
  /** realpath 之后的绝对路径 */
  path: string
  isDirectory: boolean
}

export interface DetectResult {
  /** 真实存在、已可授权的 */
  resolved: DetectedPath[]
  /**
   * 看起来是路径、但那个东西不存在的。
   *
   * 判据是**父目录存在而它自己不存在**——这几乎只可能是拼错或记错,值得
   * 回给用户。反过来,`/api/users` 这种接口路径父目录也不存在,就不会被
   * 误报成"文件找不到"。
   */
  missing: string[]
}

/**
 * 候选路径:必须出现在词首(前面是空白、引号、括号或行首),
 * 且以 `/`、`~/` 或盘符开头。
 *
 * 词首这个限制顺带挡掉了 URL——`https://x` 里的 `//` 前面是 `:`,不算词首。
 */
const QUOTED = /["'`]([^"'`\n]+)["'`]/g
const BARE = /(?:^|[\s(（,，、])((?:~|\/|[A-Za-z]:[\\/])[^\s"'`)）,，、\n]*)/g

export function detectPaths(text: string): DetectResult {
  const candidates = new Set<string>()

  // 引号里的优先:带空格的路径只能这么写
  for (const hit of text.matchAll(QUOTED)) candidates.add(hit[1])
  for (const hit of text.matchAll(BARE)) candidates.add(hit[1])

  const resolved: DetectedPath[] = []
  const missing: string[] = []
  const seen = new Set<string>()

  for (const raw of candidates) {
    if (resolved.length >= MAX_DETECTED) break
    const trimmed = raw.trim()
    const expanded = expandHome(trimmed)
    if (!expanded) continue

    if (!existsSync(expanded)) {
      // 父目录存在说明用户确实在指一个文件系统位置,只是拼错了;
      // 父目录也不存在的(如 /api/users)多半根本不是路径,不要瞎报
      if (missing.length < MAX_DETECTED && existsSync(dirname(expanded))) {
        missing.push(trimmed)
      }
      continue
    }

    let real: string
    try {
      real = realpathSync(resolve(expanded))
      if (seen.has(real)) continue
      seen.add(real)
      resolved.push({ path: real, isDirectory: statSync(real).isDirectory() })
    } catch {
      continue
    }
  }
  return { resolved, missing }
}

function expandHome(input: string): string {
  if (input === '~') return homedir()
  if (input.startsWith('~/') || input.startsWith('~\\')) {
    return resolve(homedir(), input.slice(2))
  }
  // 相对路径不认:相对谁?没有一个说得通的基准,而且极易误伤普通词组
  if (!/^(\/|[A-Za-z]:[\\/])/.test(input)) return ''
  return input
}
