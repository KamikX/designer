import { readConfig } from '../config'
import { withPage } from './browser'
import { EXTRACT_RESULTS } from './extract'

/**
 * 联网搜索。两条路,顺序固定:
 *
 * 1. **无头浏览器**跑真实搜索引擎——零配置,开箱即用
 * 2. 被反爬拦住时,退回用户在设置里配的搜索 API
 *
 * 为什么要有第 2 条:搜索引擎会改版、会上验证码,而这两种情况在结果上和
 * "确实没搜到"长得一模一样。没有退路的话,某天功能静默失效,用户只会觉得
 * "这模型怎么变笨了",根本不会想到是搜索挂了。
 */

export interface SearchHit {
  title: string
  url: string
  snippet: string
}

export interface SearchOutcome {
  hits: SearchHit[]
  /** 实际用的哪条路,给用户看的 */
  via: 'browser' | 'api'
  /** 被反爬拦住且没有可用退路时为 true */
  blocked?: boolean
}

const MAX_HITS = 8

export async function webSearch(query: string): Promise<SearchOutcome> {
  const url = `https://duckduckgo.com/?q=${encodeURIComponent(query)}&ia=web`

  try {
    const raw = await withPage<{ hits: SearchHit[]; blocked: boolean }>(url, EXTRACT_RESULTS, {
      // 搜索页是 JS 渲染的,给它久一点
      settle: 1200
    })
    if (raw.hits.length > 0) return { hits: raw.hits.slice(0, MAX_HITS), via: 'browser' }

    // 被拦住才值得动用 API 配额;真的没结果就是没结果,换个源也一样
    if (raw.blocked) {
      const fallback = await apiSearch(query)
      return fallback ?? { hits: [], via: 'browser', blocked: true }
    }
    return { hits: [], via: 'browser' }
  } catch {
    // 无头窗口起不来 / 断网 / 超时:能退就退
    const fallback = await apiSearch(query)
    return fallback ?? { hits: [], via: 'browser', blocked: true }
  }
}

/**
 * 配了 key 才走这条。没配就返回 null,由调用方如实告诉用户"被拦了且没有退路",
 * 而不是假装没搜到。
 */
async function apiSearch(query: string): Promise<SearchOutcome | null> {
  const { searchApi } = readConfig()
  if (!searchApi?.key) return null

  try {
    if (searchApi.provider === 'brave') {
      const res = await fetch(
        `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${MAX_HITS}`,
        { headers: { Accept: 'application/json', 'X-Subscription-Token': searchApi.key } }
      )
      if (!res.ok) return null
      const data = (await res.json()) as {
        web?: { results?: { title: string; url: string; description?: string }[] }
      }
      return {
        hits: (data.web?.results ?? []).map((r) => ({
          title: r.title,
          url: r.url,
          snippet: r.description ?? ''
        })),
        via: 'api'
      }
    }

    // tavily
    const res = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ api_key: searchApi.key, query, max_results: MAX_HITS })
    })
    if (!res.ok) return null
    const data = (await res.json()) as {
      results?: { title: string; url: string; content?: string }[]
    }
    return {
      hits: (data.results ?? []).map((r) => ({
        title: r.title,
        url: r.url,
        snippet: r.content ?? ''
      })),
      via: 'api'
    }
  } catch {
    return null
  }
}
