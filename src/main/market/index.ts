import { text as appText } from '../i18n'
import { readConfig } from '../config'
import type { CatalogSource, MarketMcp, MarketSkill } from './types'

/**
 * 市场数据源:从用户配置的远程地址拉 JSON。
 *
 * 内置清单已经删掉——市场内容的更新节奏和应用发版是两回事,谁维护清单也
 * 不该由代码写死。没配地址时市场就是空的,页面上会引导去设置里填。
 *
 * ## 容错原则
 *
 * 拉取失败**不抛**:市场打不开不该把整个页面炸成一个未处理的 rejection。
 * 失败时返回空清单,把原因记在 lastProblem 里,由 market:status 带给页面
 * 展示成一条人话提示。
 *
 * ## 远程内容是不可信输入
 *
 * 逐条校验形状,不合格的条目直接丢弃:一个坏条目不该拖垮整个清单,更不该
 * 带着 undefined 流进安装逻辑。安装本身各有防线(技能落文件前有路径守卫,
 * MCP 安装前有原样展示命令的确认框),这里只保证类型干净。
 */

interface Loaded {
  skills: MarketSkill[]
  mcp: MarketMcp[]
}

const TTL_MS = 5 * 60_000
const FETCH_TIMEOUT_MS = 10_000

let cached: (Loaded & { url: string; at: number }) | null = null
let lastProblem = ''

async function load(): Promise<Loaded> {
  const url = readConfig().marketUrl.trim()
  if (!url) {
    lastProblem = ''
    return { skills: [], mcp: [] }
  }
  if (cached && cached.url === url && Date.now() - cached.at < TTL_MS) return cached

  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
    if (!res.ok) throw new Error(appText('messages.marketplaceSourceReturnedHttp', res.status))
    const data = (await res.json()) as { skills?: unknown; mcp?: unknown }
    const loaded: Loaded = {
      skills: sanitizeSkills(data.skills),
      mcp: sanitizeMcp(data.mcp)
    }
    cached = { ...loaded, url, at: Date.now() }
    lastProblem = ''
    return loaded
  } catch (err) {
    lastProblem = appText(
      'market.index.failedToLoadMarketplaceSource',
      err instanceof Error ? err.message : String(err)
    )
    // 拉挂了但上次的缓存还在:继续用旧的,别让一次网络抖动清空整个市场
    if (cached && cached.url === url) return cached
    return { skills: [], mcp: [] }
  }
}

export function catalog(): CatalogSource {
  return {
    skills: async () => (await load()).skills,
    mcp: async () => (await load()).mcp
  }
}

/** 市场页的状态条:配没配地址、最近一次拉取有没有问题 */
export async function marketStatus(): Promise<{ url: string; problem?: string }> {
  await load()
  const url = readConfig().marketUrl.trim()
  return { url, ...(lastProblem ? { problem: lastProblem } : {}) }
}

/* ------------------------------------------------------------------ */
/* 形状校验                                                            */
/* ------------------------------------------------------------------ */

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function strList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []
}

function sanitizeSkills(value: unknown): MarketSkill[] {
  if (!Array.isArray(value)) return []
  const out: MarketSkill[] = []
  for (const item of value as Record<string, unknown>[]) {
    const id = str(item?.id)
    const name = str(item?.name)
    const content = str(item?.content)
    // 三样缺一不可:id 是安装的定位键,name 是落地目录名,content 是正文
    if (!id || !name || !content) continue
    out.push({ id, name, description: str(item.description), tags: strList(item.tags), content })
  }
  return out
}

const TRANSPORTS = new Set(['stdio', 'sse', 'http'])

function sanitizeMcp(value: unknown): MarketMcp[] {
  if (!Array.isArray(value)) return []
  const out: MarketMcp[] = []
  for (const item of value as Record<string, unknown>[]) {
    const id = str(item?.id)
    const name = str(item?.name)
    const transport = str(item?.transport) as MarketMcp['transport']
    if (!id || !name || !TRANSPORTS.has(transport)) continue
    // stdio 必须有 command,远程必须有 url——缺了装上也起不来
    const command = str(item.command)
    const url = str(item.url)
    if (transport === 'stdio' ? !command : !url) continue
    out.push({
      id,
      name,
      description: str(item.description),
      tags: strList(item.tags),
      transport,
      ...(command ? { command } : {}),
      ...(Array.isArray(item.args) ? { args: strList(item.args) } : {}),
      ...(url ? { url } : {}),
      ...(Array.isArray(item.envHints)
        ? {
            envHints: (item.envHints as Record<string, unknown>[])
              .filter((h) => str(h?.key) && str(h?.label))
              .map((h) => ({
                key: str(h.key),
                label: str(h.label),
                ...(str(h.help) ? { help: str(h.help) } : {})
              }))
          }
        : {}),
      ...(str(item.homepage) ? { homepage: str(item.homepage) } : {})
    })
  }
  return out
}

export type { CatalogSource, EnvHint, MarketMcp, MarketSkill } from './types'
