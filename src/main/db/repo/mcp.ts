import { asc, eq, sql } from 'drizzle-orm'
import type { McpServer, McpServerInput, McpTransport } from '../../../shared/types'
import { getDb } from '../index'
import { mcpServers } from '../schema'
import type { McpServerRow } from '../schema'

/** MCP 服务配置仓储。args/env/headers 在库里是 JSON 文本,转换收口在这里。 */

function parseJson<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw)
  } catch {
    return fallback
  }
}

function toView(row: McpServerRow): McpServer {
  return {
    id: row.id,
    name: row.name,
    transport: row.transport as McpTransport,
    command: row.command,
    args: parseJson<string[]>(row.args, []),
    env: parseJson<Record<string, string>>(row.env, {}),
    url: row.url,
    headers: parseJson<Record<string, string>>(row.headers, {}),
    enabled: row.enabled,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  }
}

export function listMcpServers(): McpServer[] {
  return getDb().select().from(mcpServers).orderBy(asc(mcpServers.createdAt)).all().map(toView)
}

export function createMcpServer(input: McpServerInput): McpServer {
  return toView(
    getDb()
      .insert(mcpServers)
      .values({
        name: input.name,
        transport: input.transport,
        command: input.command ?? null,
        args: JSON.stringify(input.args ?? []),
        env: JSON.stringify(input.env ?? {}),
        url: input.url ?? null,
        headers: JSON.stringify(input.headers ?? {})
      })
      .returning()
      .get()
  )
}

export function updateMcpServer(
  id: string,
  patch: Partial<McpServerInput> & { enabled?: boolean }
): McpServer | null {
  const row = getDb()
    .update(mcpServers)
    .set({
      ...(patch.name != null ? { name: patch.name } : {}),
      ...(patch.transport != null ? { transport: patch.transport } : {}),
      ...(patch.command !== undefined ? { command: patch.command ?? null } : {}),
      ...(patch.args != null ? { args: JSON.stringify(patch.args) } : {}),
      ...(patch.env != null ? { env: JSON.stringify(patch.env) } : {}),
      ...(patch.url !== undefined ? { url: patch.url ?? null } : {}),
      ...(patch.headers != null ? { headers: JSON.stringify(patch.headers) } : {}),
      ...(patch.enabled != null ? { enabled: patch.enabled } : {}),
      updatedAt: sql`(datetime('now'))`
    })
    .where(eq(mcpServers.id, id))
    .returning()
    .get()
  return row ? toView(row) : null
}

export function deleteMcpServer(id: string): void {
  getDb().delete(mcpServers).where(eq(mcpServers.id, id)).run()
}

/**
 * 导入标准 mcpServers JSON(Claude Desktop / Cursor 同款格式)。
 *
 * 接受两种形态:
 *   { "mcpServers": { "<name>": {...}, ... } }
 *   { "<name>": { command|url, ... }, ... }
 * 单个 server 配置:{command, args?, env?} 视为 stdio;
 * {url, type?|transport?, headers?} 视为 sse/http(缺省按 url 猜 sse)。
 * 与已有同名的跳过不覆盖,返回本次新增的列表。
 */
export function importMcpJson(json: string): McpServer[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    throw new Error('JSON 格式不合法')
  }
  if (typeof parsed !== 'object' || parsed == null) throw new Error('JSON 内容不是对象')

  const root = parsed as Record<string, unknown>
  const map = (
    typeof root.mcpServers === 'object' && root.mcpServers != null ? root.mcpServers : root
  ) as Record<string, unknown>

  const existingNames = new Set(listMcpServers().map((s) => s.name))
  const created: McpServer[] = []

  for (const [name, raw] of Object.entries(map)) {
    if (typeof raw !== 'object' || raw == null) continue
    const cfg = raw as Record<string, unknown>
    const hasCommand = typeof cfg.command === 'string' && cfg.command.length > 0
    const hasUrl = typeof cfg.url === 'string' && cfg.url.length > 0
    if (!hasCommand && !hasUrl) continue
    if (existingNames.has(name)) continue

    const transport: McpTransport = hasCommand
      ? 'stdio'
      : ((cfg.type ?? cfg.transport) as string) === 'http'
        ? 'http'
        : 'sse'

    created.push(
      createMcpServer({
        name,
        transport,
        command: hasCommand ? (cfg.command as string) : undefined,
        args: Array.isArray(cfg.args) ? cfg.args.map(String) : undefined,
        env:
          typeof cfg.env === 'object' && cfg.env != null
            ? (cfg.env as Record<string, string>)
            : undefined,
        url: hasUrl ? (cfg.url as string) : undefined,
        headers:
          typeof cfg.headers === 'object' && cfg.headers != null
            ? (cfg.headers as Record<string, string>)
            : undefined
      })
    )
    existingNames.add(name)
  }

  if (created.length === 0) {
    throw new Error('没有可导入的服务(可能都已存在,或 JSON 里没有合法的 server 配置)')
  }
  return created
}
