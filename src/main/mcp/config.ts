import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { DATA_DIR, ensureDataDirs } from '../paths'

/**
 * MCP 配置文件:`~/.antd-designer/mcp.json`。
 *
 * ## 为什么读三种方言
 *
 * MCP 的配置格式**至今没有统一标准**(SEP-2633 还是 draft)。现状:
 *
 * | 工具 | 顶层键 | 格式 |
 * | --- | --- | --- |
 * | Claude Desktop / Claude Code / Cursor | `mcpServers` | JSON |
 * | VS Code | `servers` | JSON |
 * | Codex | `mcp_servers` | TOML |
 *
 * 用户几乎一定是从别处复制一段配置过来的。只认一种的话,他会遇到"我明明贴了
 * 配置却没有服务"——而 VS Code 的 `servers` 和 Claude 的 `mcpServers` 长得几乎
 * 一样,肉眼很难发现差别。**我们写用 `mcpServers`(最主流),读三种都认。**
 *
 * TOML 那种暂不解析(要再引一个依赖),但识别出来给一句人话提示,而不是静默
 * 当成空配置。
 *
 * ## 密钥不进这个文件
 *
 * 这个文件用户会拷来拷去、贴进 issue、同步到网盘。密钥走 safeStorage 加密存储,
 * 这里只留 `${VAR}` 占位符,启动进程时才展开。
 */

export interface McpServerConfig {
  /** stdio(默认) | http | sse */
  type?: 'stdio' | 'http' | 'sse'
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
  headers?: Record<string, string>
  /** 关掉但保留配置 */
  enabled?: boolean
}

export type McpConfigFile = Record<string, McpServerConfig>

const FILE = join(DATA_DIR, 'mcp.json')

export function mcpConfigPath(): string {
  return FILE
}

export interface McpReadResult {
  servers: McpConfigFile
  /** 文件有问题时给用户的人话。不抛异常——配置坏了不该让整个应用起不来 */
  problem?: string
}

export function readMcpConfig(): McpReadResult {
  if (!existsSync(FILE)) return { servers: {} }

  let raw: string
  try {
    raw = readFileSync(FILE, 'utf-8')
  } catch (err) {
    return { servers: {}, problem: `读不了 ${FILE}:${message(err)}` }
  }
  return parseMcpText(raw, FILE)
}

/**
 * 解析一段 MCP 配置文本。独立出来是因为有两个入口:读 mcp.json 本体,
 * 和用户在界面上粘贴一段从别的工具拷来的配置("从 JSON 导入")。
 */
export function parseMcpText(raw: string, sourceLabel = '配置'): McpReadResult {
  // TOML 是 Codex 的方言。识别出来说清楚,别让用户对着一个"空配置"发呆
  if (/^\s*\[mcp_servers\./m.test(raw)) {
    return {
      servers: {},
      problem: `${sourceLabel} 看起来是 Codex 的 TOML 格式。本应用读 JSON,请改写成 { "mcpServers": { … } }。`
    }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    return { servers: {}, problem: `${sourceLabel} 不是合法 JSON:${message(err)}` }
  }

  const root = parsed as Record<string, unknown>
  // VS Code 用 servers,其余用 mcpServers。两者结构一致,只是键名不同
  const block = (root.mcpServers ?? root.servers) as Record<string, McpServerConfig> | undefined
  if (!block || typeof block !== 'object') {
    return { servers: {}, problem: `${sourceLabel} 里没有 mcpServers(或 servers)字段。` }
  }
  return { servers: block }
}

export function writeMcpConfig(servers: McpConfigFile): void {
  ensureDataDirs()
  writeFileSync(FILE, `${JSON.stringify({ mcpServers: servers }, null, 2)}\n`, 'utf-8')
}

/** 合并写入一条,保留其余。返回是否是新增 */
export function upsertMcpServer(name: string, config: McpServerConfig): boolean {
  const { servers } = readMcpConfig()
  const isNew = !(name in servers)
  writeMcpConfig({ ...servers, [name]: config })
  return isNew
}

/**
 * 展开 `${VAR}` 与 `${VAR:-默认值}`。
 *
 * 只在**启动进程前**做,展开结果不写回文件。缺变量时保留原样并记下来——
 * 换成空串的话,服务会带着一个空 token 启动,然后报一个和"没配密钥"毫不相干的
 * 认证错误。
 */
export function expand(
  value: string,
  env: Record<string, string | undefined>
): { text: string; missing: string[] } {
  const missing: string[] = []
  const text = value.replace(
    /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g,
    (all, key, fallback) => {
      const found = env[key as string]
      if (found !== undefined && found !== '') return found
      if (fallback !== undefined) return fallback as string
      missing.push(key as string)
      return all
    }
  )
  return { text, missing }
}

/** 对整条配置做展开,返回缺失的变量名 */
export function resolveConfig(
  config: McpServerConfig,
  env: Record<string, string | undefined>
): { config: McpServerConfig; missing: string[] } {
  const missing = new Set<string>()
  const one = (value: string): string => {
    const result = expand(value, env)
    result.missing.forEach((m) => missing.add(m))
    return result.text
  }
  const map = (input?: Record<string, string>): Record<string, string> | undefined =>
    input ? Object.fromEntries(Object.entries(input).map(([k, v]) => [k, one(v)])) : undefined

  return {
    config: {
      ...config,
      ...(config.command ? { command: one(config.command) } : {}),
      ...(config.args ? { args: config.args.map(one) } : {}),
      ...(config.env ? { env: map(config.env)! } : {}),
      ...(config.url ? { url: one(config.url) } : {}),
      ...(config.headers ? { headers: map(config.headers)! } : {})
    },
    missing: [...missing]
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
