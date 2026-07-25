import type { McpServerInput, McpServerView, McpTransport } from '../../shared/types'
import { parseMcpText, readMcpConfig, writeMcpConfig } from './config'
import { allSecrets } from './secrets'
import type { McpServerConfig } from './config'

/**
 * MCP 的领域服务:mcp.json 是**唯一事实来源**,这里只是它的读写门面。
 *
 * 以前 MCP 有三个来源:数据库表(设置页管理)、mcp.json(AI 自助安装写入)、
 * 市场(又写数据库)。AI 装的服务用户在设置里看不到,设置里配的 AI 又用不上。
 * 现在全部收敛到 mcp.json——它本来就是跨工具生态的通用形态,用户从 Claude
 * Desktop / Cursor 拷一段配置就能用。
 *
 * 身份就是名字(mcp.json 的键),没有 id。改名 = 删旧加新,会话勾选按名字失配
 * 后由渲染层 reconcile 掉,和技能同一套规则。
 */

/** 配置里引用了、但环境变量和密钥库都给不出的 ${VAR},列出来在界面上标黄 */
function missingEnvOf(config: McpServerConfig): string[] {
  const pool = { ...process.env, ...allSecrets() }
  const missing = new Set<string>()
  const scan = (value: string): void => {
    for (const match of value.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-[^}]*)?\}/g)) {
      const [whole, key] = match
      // 带默认值的 ${VAR:-x} 不算缺
      if (whole.includes(':-')) continue
      const found = pool[key]
      if (found === undefined || found === '') missing.add(key)
    }
  }
  if (config.command) scan(config.command)
  config.args?.forEach(scan)
  Object.values(config.env ?? {}).forEach(scan)
  if (config.url) scan(config.url)
  Object.values(config.headers ?? {}).forEach(scan)
  return [...missing]
}

function toView(name: string, config: McpServerConfig): McpServerView {
  const transport: McpTransport = config.type ?? (config.url ? 'http' : 'stdio')
  const missingEnv = missingEnvOf(config)
  return {
    name,
    transport,
    command: config.command ?? null,
    args: config.args ?? [],
    env: config.env ?? {},
    url: config.url ?? null,
    headers: config.headers ?? {},
    enabled: config.enabled !== false,
    ...(missingEnv.length ? { missingEnv } : {})
  }
}

export function listMcpViews(): { servers: McpServerView[]; problem?: string } {
  const { servers, problem } = readMcpConfig()
  return {
    servers: Object.entries(servers).map(([name, config]) => toView(name, config)),
    ...(problem ? { problem } : {})
  }
}

export function upsertMcp(name: string, input: McpServerInput): McpServerView {
  const trimmed = name.trim()
  if (!trimmed) throw new Error('服务名不能为空')
  const config: McpServerConfig = {
    ...(input.transport !== 'stdio' ? { type: input.transport } : {}),
    ...(input.command ? { command: input.command } : {}),
    ...(input.args?.length ? { args: input.args } : {}),
    ...(input.env && Object.keys(input.env).length ? { env: input.env } : {}),
    ...(input.url ? { url: input.url } : {}),
    ...(input.headers && Object.keys(input.headers).length ? { headers: input.headers } : {}),
    ...(input.enabled === false ? { enabled: false } : {})
  }
  const { servers } = readMcpConfig()
  writeMcpConfig({ ...servers, [trimmed]: config })
  return toView(trimmed, config)
}

export function setMcpEnabled(name: string, enabled: boolean): void {
  const { servers } = readMcpConfig()
  const current = servers[name]
  if (!current) return
  writeMcpConfig({
    ...servers,
    [name]: { ...current, ...(enabled ? { enabled: undefined } : { enabled: false }) }
  })
}

export function removeMcp(name: string): void {
  const { servers } = readMcpConfig()
  if (!(name in servers)) return
  const next = { ...servers }
  delete next[name]
  writeMcpConfig(next)
}

/** 粘贴一段别的工具的配置,合并进 mcp.json。返回新增/覆盖的服务 */
export function importMcpText(json: string): McpServerView[] {
  const { servers: incoming, problem } = parseMcpText(json, '粘贴的配置')
  if (problem) throw new Error(problem)
  const names = Object.keys(incoming)
  if (names.length === 0) throw new Error('配置里没有任何服务。')
  const { servers } = readMcpConfig()
  writeMcpConfig({ ...servers, ...incoming })
  return names.map((n) => toView(n, incoming[n]))
}
