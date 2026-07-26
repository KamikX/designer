import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MIGRATIONS } from '../db/migrations'
import * as schema from '../db/schema'

/**
 * 数据库隐私审计:用带金丝雀密钥的代表性追踪打满五张观测表,然后逐表
 * 逐文本列扫一遍——prompt、reasoning、文件正文、补丁、搜索词、绝对路径、
 * basename、答案、URL path/query、邮箱、凭证,一个都不许活着落库。
 */

let sqlite: Database.Database
let testDb: BetterSQLite3Database<typeof schema>

vi.mock('../db/index', () => ({ getDb: () => testDb }))

import { RunTraceCollector } from './run-trace'

const CANARIES = {
  prompt: '用户的秘密需求:给我做一个薪酬系统',
  fileBody: 'const SALARY_TABLE = [900000, 1200000]',
  patch: '*** Update File: 秘密工资表.vue',
  searchTerm: '薪酬明细搜索词',
  absolutePath: '/Users/alice/company/salary-secrets',
  basename: 'salary-secrets.xlsx',
  answer: '我的选择是泄露选项A',
  urlPath: '/reset-password?token=tok-canary-9f8e7d',
  email: 'alice.secret@example-canary.com',
  credential: 'sk-live-canaryabcdef1234567890'
}

function runMigrations(conn: Database.Database): void {
  conn.pragma('foreign_keys = OFF')
  for (let v = 0; v < MIGRATIONS.length; v++) {
    conn.transaction(() => {
      conn.exec(MIGRATIONS[v])
      conn.pragma(`user_version = ${v + 1}`)
    })()
  }
  conn.pragma('foreign_keys = ON')
}

beforeEach(() => {
  sqlite = new Database(':memory:')
  runMigrations(sqlite)
  testDb = drizzle(sqlite, { schema })
})

const OBS_TABLES = [
  'ai_runs',
  'ai_run_steps',
  'tool_runs',
  'model_usage_daily',
  'model_usage_run_days'
]

function allTextValues(): string {
  const chunks: string[] = []
  for (const table of OBS_TABLES) {
    const columns = (
      sqlite.prepare(`PRAGMA table_info(${table})`).all() as { name: string; type: string }[]
    ).filter((c) => c.type.toLowerCase().includes('text'))
    for (const row of sqlite.prepare(`SELECT * FROM ${table}`).all() as Record<string, unknown>[]) {
      for (const col of columns) {
        const value = row[col.name]
        if (typeof value === 'string') chunks.push(value)
      }
    }
  }
  return chunks.join('\n')
}

describe('观测表隐私审计', () => {
  it('代表性追踪跑完后,任何金丝雀都不在五张表里', () => {
    const collector = new RunTraceCollector({
      scene: 'design',
      messageId: 'm1',
      conversationId: 'c1',
      providerId: 'prov-1',
      providerSlug: 'openai',
      modelId: 'gpt-test',
      adapter: 'openai'
    })
    collector.start()
    collector.modelCallStart('call-1')

    const traces: [string, unknown, { mcp?: boolean }?][] = [
      // 设计稿写入:content 是整份文件正文
      ['write_file', { path: 'pages/salary.vue', content: CANARIES.fileBody }],
      // 补丁正文
      ['apply_patch', { patch: `${CANARIES.patch}\n@@\n-${CANARIES.fileBody}\n+x` }],
      // 设计稿搜索词
      ['search_files', { query: CANARIES.searchTerm }],
      // 本地 workspace 绝对路径
      ['read_local_file', { path: `${CANARIES.absolutePath}/${CANARIES.basename}` }],
      // 浏览器/网络:URL 带 token,邮箱在参数里
      [
        'web_fetch',
        { url: `https://intranet.example.com${CANARIES.urlPath}&mail=${CANARIES.email}` }
      ],
      ['web_search', { query: `${CANARIES.credential} 是什么` }],
      // ask_user:题目与答案
      [
        'ask_user',
        { questions: [{ question: CANARIES.prompt, options: [{ label: CANARIES.answer }] }] }
      ],
      // MCP:字段值一律不看
      [
        'jira_create_issue',
        { summary: CANARIES.prompt, token: CANARIES.credential },
        { mcp: true }
      ],
      // 未注册工具
      ['mystery_tool', { blob: CANARIES.credential }]
    ]

    for (const [index, [tool, input, opts]] of traces.entries()) {
      const callId = `tool-${index}`
      collector.toolInputStart(callId, tool, opts)
      collector.toolInputEnd(callId, input, JSON.stringify(input).length)
      collector.toolExecutionStart(callId)
      collector.toolExecutionEnd(callId, {
        status: index % 3 === 2 ? 'recoverable_error' : 'success',
        outputChars: 64,
        // 错误摘要里故意夹私货,二次脱敏必须兜住
        errorSummary:
          index % 3 === 2
            ? `失败于 ${CANARIES.absolutePath}/${CANARIES.basename},凭证 ${CANARIES.credential},联系 ${CANARIES.email}`
            : null
      })
    }

    // provider 失败:原始 body 不落库,只有映射码
    collector.modelCallEnd('call-1', {
      status: 'error',
      httpStatus: 500,
      errorCode: 'UPSTREAM_ERROR'
    })
    collector.modelCallStart('call-2')
    collector.stepEnd('call-2', {
      inputTokens: 100,
      inputTokenDetails: { noCacheTokens: 60, cacheReadTokens: 40, cacheWriteTokens: undefined },
      outputTokens: 20,
      outputTokenDetails: { textTokens: 12, reasoningTokens: 8 },
      totalTokens: 120,
      raw: { total_tokens: 121, leaked_prompt: CANARIES.prompt }
    })
    collector.finish('error')

    // 表里确实有数据(审计不是在空表上空转)
    expect(sqlite.prepare('SELECT count(*) n FROM tool_runs').get()).toEqual({ n: 9 })
    expect(sqlite.prepare('SELECT count(*) n FROM ai_run_steps').get()).toEqual({ n: 2 })
    expect(sqlite.prepare('SELECT count(*) n FROM model_usage_daily').get()).toEqual({ n: 1 })

    const haystack = allTextValues()
    for (const [name, canary] of Object.entries(CANARIES)) {
      expect(haystack, `金丝雀 ${name} 泄漏进了观测表`).not.toContain(canary)
    }
    // 设计稿相对路径是白名单允许的(合法且必要)
    expect(haystack).toContain('pages/salary.vue')
    // provider 原始 raw 里的夹带字段没有随白名单提取一起进来
    expect(haystack).not.toContain('leaked_prompt')
  })
})
