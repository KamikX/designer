import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { dynamicTool, jsonSchema } from 'ai'
import type { ToolSet } from 'ai'
import { readMcpConfig, resolveConfig } from './config'
import { allSecrets } from './secrets'

/**
 * 把 mcp.json 里勾选的服务连成真正可调用的工具。
 *
 * AI SDK v7 没有内置 MCP 客户端,这里用官方 @modelcontextprotocol/sdk 直连,
 * 再用 dynamicTool 包一层——MCP 工具的入参 schema 只有运行时才知道,
 * dynamicTool + jsonSchema 正是为这种情况准备的。
 *
 * ## 生命周期
 *
 * 按**轮**连接:sendChat 开始时连,流结束(含出错)后关。不做常驻连接池——
 * stdio 服务是子进程,常驻意味着应用一开就挂着 N 个 npm 进程,而多数轮次
 * 根本用不到它们。连接慢的代价(一两秒)只在勾了 MCP 的轮次发生。
 *
 * ## 失败语义
 *
 * 单个服务连不上**不拖垮整轮对话**:跳过它,把原因写进 warnings,渲染层
 * 展示给用户。缺 ${VAR} 的直接跳过而不是带着字面量 "${GITHUB_TOKEN}" 去连
 * ——那会换来一个和"没配密钥"毫不相干的认证错误。
 */

export interface McpSession {
  tools: ToolSet
  /** 没连上的服务与原因,给用户看 */
  warnings: string[]
  close: () => Promise<void>
}

const CONNECT_TIMEOUT_MS = 10_000

/** OpenAI 协议要求工具名 ^[a-zA-Z0-9_-]{1,64}$;中文服务名清洗后可能为空,给个兜底 */
function slugOf(name: string, index: number): string {
  const cleaned = name.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 24)
  return cleaned || `mcp${index}`
}

export async function connectMcpTools(names: string[]): Promise<McpSession> {
  const empty: McpSession = { tools: {}, warnings: [], close: async () => {} }
  if (names.length === 0) return empty

  const { servers, problem } = readMcpConfig()
  const warnings: string[] = problem ? [problem] : []
  const tools: ToolSet = {}
  const clients: Client[] = []
  const env = { ...process.env, ...allSecrets() }

  await Promise.all(
    names.map(async (name, index) => {
      const raw = servers[name]
      if (!raw) {
        warnings.push(`MCP「${name}」不在 mcp.json 里,已跳过。`)
        return
      }
      if (raw.enabled === false) return

      const { config, missing } = resolveConfig(raw, env)
      if (missing.length) {
        warnings.push(`MCP「${name}」缺少环境变量 ${missing.join(', ')},已跳过。`)
        return
      }

      try {
        const client = await connectOne(name, config)
        clients.push(client)
        const { tools: listed } = await client.listTools()
        const prefix = slugOf(name, index)
        for (const t of listed) {
          const key = `${prefix}_${t.name}`.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64)
          tools[key] = dynamicTool({
            description: `[${name}] ${t.description ?? t.name}`,
            inputSchema: jsonSchema(t.inputSchema as Parameters<typeof jsonSchema>[0]),
            execute: async (input) => {
              const result = await client.callTool({
                name: t.name,
                arguments: (input ?? {}) as Record<string, unknown>
              })
              return renderResult(result)
            }
          })
        }
      } catch (err) {
        warnings.push(`MCP「${name}」连接失败:${err instanceof Error ? err.message : String(err)}`)
      }
    })
  )

  return {
    tools,
    warnings,
    close: async () => {
      // 关不掉也别抛:流已经结束了,这里抛出去没有任何接的人
      await Promise.all(clients.map((c) => c.close().catch(() => {})))
    }
  }
}

async function connectOne(
  name: string,
  config: import('./config').McpServerConfig
): Promise<Client> {
  const type = config.type ?? (config.url ? 'http' : 'stdio')

  const transport = (() => {
    if (type === 'stdio') {
      if (!config.command) throw new Error('stdio 服务缺少 command')
      return new StdioClientTransport({
        command: config.command,
        args: config.args ?? [],
        // 子进程继承我们的环境再叠配置里的:npx 之类的命令要 PATH 才找得到
        env: { ...(process.env as Record<string, string>), ...(config.env ?? {}) }
      })
    }
    if (!config.url) throw new Error(`${type} 服务缺少 url`)
    const url = new URL(config.url)
    const init = config.headers ? { requestInit: { headers: config.headers } } : {}
    return type === 'sse'
      ? new SSEClientTransport(url, init)
      : new StreamableHTTPClientTransport(url, init)
  })()

  const client = new Client({ name: 'antd-designer', version: '1.0.0' })
  await withTimeout(
    client.connect(transport),
    CONNECT_TIMEOUT_MS,
    `连接「${name}」超过 ${CONNECT_TIMEOUT_MS / 1000} 秒`
  )
  return client
}

function withTimeout<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(label)), ms)
    work.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (err) => {
        clearTimeout(timer)
        reject(err)
      }
    )
  })
}

/**
 * MCP 的结果是 content 分片数组,拍平成文本给模型。
 * 非文本分片(图片/资源)不展开,标注类型让模型知道有东西没看到。
 */
function renderResult(result: Awaited<ReturnType<Client['callTool']>>): string {
  const content = (result.content ?? []) as { type: string; text?: string }[]
  const text = content
    .map((c) => (c.type === 'text' ? (c.text ?? '') : `[${c.type} 内容,已省略]`))
    .filter(Boolean)
    .join('\n')
  if (result.isError) return `工具执行出错:${text || '(无详情)'}`
  return text || '(无输出)'
}
