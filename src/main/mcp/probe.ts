import { text as appText } from '../i18n'
import { resolveConfig } from './config'
import type { McpServerConfig } from './config'

/**
 * 连一次 MCP 服务,把它提供的工具列出来。
 *
 * ## 为什么装完必须测
 *
 * MCP 配错的表现极其隐蔽:包名拼错、缺 node、密钥没配、命令路径不对——这些都不会
 * 在"保存配置"时报错,而是**下一次对话时那些工具莫名其妙不存在**。用户根本不会
 * 联想到是安装环节的问题,只会觉得"这个 AI 怎么不会用工具"。
 *
 * 所以安装即连接一次,当场给结论。
 *
 * ## 超时必须有
 *
 * `npx -y 某个包` 首次运行要从 npm 下载,可能几十秒;而配错的情况下它可能永远
 * 挂着(比如等一个不存在的端口)。没有超时的话安装流程就卡死了。
 */

/** 首次运行要下载依赖,给宽一点;但不能没有上限 */
const TIMEOUT_MS = 60_000

export interface ProbeResult {
  ok: boolean
  /** 成功时:服务提供的工具名 */
  tools?: string[]
  /** 失败时的人话 */
  error?: string
  /** 配置里引用了但环境里没有的变量 */
  missingEnv?: string[]
}

export async function probeMcpServer(
  name: string,
  raw: McpServerConfig,
  secrets: Record<string, string> = {}
): Promise<ProbeResult> {
  const env = { ...process.env, ...secrets }
  const { config, missing } = resolveConfig(raw, env)

  // 缺变量就不要连了:带着一个未展开的 ${TOKEN} 连上去,拿到的是一条和"没配密钥"
  // 毫不相干的认证错误,反而更难查
  if (missing.length) {
    return {
      ok: false,
      error: appText('messages.missingEnvironmentVariables', missing.join('、')),
      missingEnv: missing
    }
  }

  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
  const client = new Client({ name: 'antd-designer', version: '1.0.0' }, { capabilities: {} })

  let transport: { close(): Promise<void> } | undefined
  try {
    transport = await buildTransport(config, env)
    await withTimeout(
      client.connect(transport as never),
      TIMEOUT_MS,
      appText('messages.connectionTimedOutSTheFirst', TIMEOUT_MS / 1000)
    )
    const listed = await withTimeout(
      client.listTools(),
      TIMEOUT_MS,
      appText('messages.timedOutWhileFetchingTheToolList')
    )
    return { ok: true, tools: listed.tools.map((t) => t.name) }
  } catch (err) {
    return { ok: false, error: describe(err, name) }
  } finally {
    // 探测完必须关掉,否则每装一次就留一个常驻子进程
    await client.close().catch(() => {})
    await transport?.close().catch(() => {})
  }
}

async function buildTransport(
  config: McpServerConfig,
  env: Record<string, string | undefined>
): Promise<{ close(): Promise<void> }> {
  const type = config.type ?? (config.url ? 'http' : 'stdio')

  if (type === 'stdio') {
    if (!config.command) throw new Error(appText('messages.theStdioTypeRequiresACommand'))
    const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js')
    return new StdioClientTransport({
      command: config.command,
      args: config.args ?? [],
      // 只传字符串值:PATH 之类缺了的话 npx 根本找不到
      env: Object.fromEntries(
        Object.entries({ ...env, ...config.env }).filter(([, v]) => typeof v === 'string')
      ) as Record<string, string>
    })
  }

  if (!config.url) throw new Error(appText('messages.theTypeRequiresAUrl', type))
  if (type === 'sse') {
    const { SSEClientTransport } = await import('@modelcontextprotocol/sdk/client/sse.js')
    return new SSEClientTransport(new URL(config.url), {
      requestInit: { headers: config.headers }
    })
  }
  const { StreamableHTTPClientTransport } =
    await import('@modelcontextprotocol/sdk/client/streamableHttp.js')
  return new StreamableHTTPClientTransport(new URL(config.url), {
    requestInit: { headers: config.headers }
  })
}

/** 把底层错误翻成能照着改的话 */
function describe(err: unknown, name: string): string {
  const text = err instanceof Error ? err.message : String(err)
  if (/ENOENT/.test(text))
    return appText('messages.commandNotFoundCheckItsSpellingOrInstallTheProgram', text)
  if (/EACCES/.test(text)) return appText('common.permissionDenied', text)
  if (/ECONNREFUSED|fetch failed/i.test(text))
    return appText('messages.cannotConnectToTheRemoteService', text)
  if (/401|403|unauthorized/i.test(text))
    return appText('messages.authenticationFailedCheckTheCredentials', text)
  return appText('messages.failedToStart', name, text)
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms)
    })
  ])
}
