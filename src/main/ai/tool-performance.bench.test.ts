import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { streamText } from 'ai'
import { MockLanguageModelV3, simulateReadableStream } from 'ai/test'
import { describe, expect, it } from 'vitest'
import { AnchorRegistry } from './anchor-registry'
import {
  ContextGovernor,
  ToolBudgetGate,
  resolveToolLimits,
  wrapToolsWithBudget
} from './context-governor'
import { DEFAULT_TOOL_CALL_LIMIT } from '../../shared/limits'
import { RunContextLedger } from './run-context-ledger'
import { SessionVfs } from './session-vfs'
import { MagicStringBatchEditor } from './string-edits'
import { buildFileTools } from './tools'

/**
 * 固定 RBAC 基准:7 个合成 Vue/CSS 文件、约 25KB、同时修改 5 个文件、
 * 含 800–1700 字符超长行。fixture 完全合成,不含任何用户项目数据;
 * 字节数与超长行钉死在断言里——将来一次"顺手格式化"悄悄抹掉压力场景时,
 * 这里会先响。
 */

// 从 Mock 类反推 v3 分片类型:'ai/test' 不导出类型
type V3StreamResult = Awaited<ReturnType<InstanceType<typeof MockLanguageModelV3>['doStream']>>
type V3StreamPart = V3StreamResult['stream'] extends ReadableStream<infer P> ? P : never

const FIXTURE_DIR = join(__dirname, 'fixtures', 'rbac-benchmark')

/** fixture 的精确字节数。改 fixture 必须同步改这里并重录基准文档 */
const FIXTURE_TOTAL_BYTES = 24_103
const EXPECTED_LONG_LINES = [854, 1068, 1390, 1670]

function loadFixture(): { path: string; content: string }[] {
  return readdirSync(FIXTURE_DIR)
    .sort()
    .map((name) => ({
      path: `rbac/${name}`,
      content: readFileSync(join(FIXTURE_DIR, name), 'utf-8')
    }))
}

describe('fixture 基线', () => {
  it('7 个文件、约 25KB、超长行俱在', () => {
    const files = loadFixture()
    expect(files).toHaveLength(7)
    const totalBytes = files.reduce((n, f) => n + Buffer.byteLength(f.content, 'utf-8'), 0)
    expect(totalBytes).toBe(FIXTURE_TOTAL_BYTES)

    const longLines = files
      .flatMap((f) => f.content.split('\n'))
      .filter((line) => line.length >= 800)
      .map((line) => line.length)
      .sort((a, b) => a - b)
    expect(longLines).toEqual(EXPECTED_LONG_LINES)
    for (const len of longLines) {
      expect(len).toBeGreaterThanOrEqual(800)
      expect(len).toBeLessThanOrEqual(1700)
    }
  })
})

describe('本地批量编辑基准', () => {
  it('五文件原子编辑 p95 < 100ms', () => {
    const TARGETS = [
      'rbac/App.vue',
      'rbac/RoleList.vue',
      'rbac/UserTable.vue',
      'rbac/RoleForm.vue',
      'rbac/admin.css'
    ]
    const ITERATIONS = 30
    const durations: number[] = []

    for (let i = 0; i < ITERATIONS; i++) {
      const vfs = new SessionVfs(loadFixture())
      const registry = new AnchorRegistry()
      const editor = new MagicStringBatchEditor(vfs, registry)
      // 每个目标文件取第一行做锚点(其中包括 1670 字符的压缩 CSS 行)
      const operations = TARGETS.map((path) => {
        const revision = vfs.revisionOf(path)!
        const { anchor } = registry.capture(path, revision, vfs.raw(path).content, {
          startLine: 1
        })
        return { type: 'replace' as const, anchorId: anchor.id, content: `/* 第 ${i} 轮 */` }
      })

      const start = performance.now()
      editor.apply(operations)
      durations.push(performance.now() - start)

      for (const path of TARGETS) expect(vfs.raw(path).content).toContain(`第 ${i} 轮`)
    }

    durations.sort((a, b) => a - b)
    const p95 = durations[Math.floor(ITERATIONS * 0.95) - 1]

    console.info(
      `[bench] 五文件原子编辑 p50=${durations[Math.floor(ITERATIONS / 2)].toFixed(2)}ms p95=${p95.toFixed(2)}ms`
    )
    expect(p95).toBeLessThan(100)
  })
})

describe('确定性编排基准', () => {
  it('5 文件修改:无截断失配、无重复失败、调用数在软阈值内', async () => {
    const vfs = new SessionVfs(loadFixture())
    const ledger = new RunContextLedger()
    const limits = resolveToolLimits(DEFAULT_TOOL_CALL_LIMIT)
    const gate = new ToolBudgetGate(limits.hard)
    const governor = new ContextGovernor({ ledger, gate, contextWindow: 64_000, limits })
    const tools = wrapToolsWithBudget(
      buildFileTools(
        vfs,
        { onPatch: () => {}, onDelete: () => {} },
        { ledger, readGate: (p, r) => governor.readGate(p, r) }
      ),
      gate
    )

    const TARGETS = [
      'rbac/RoleList.vue',
      'rbac/UserTable.vue',
      'rbac/RoleForm.vue',
      'rbac/admin.css',
      'rbac/theme.css'
    ]
    const toolResults: string[] = []
    let step = 0
    const model = new MockLanguageModelV3({
      doStream: async (options) => {
        step += 1
        let chunks: unknown[]
        if (step === 1) {
          // 第一步:并行捕获 5 个文件的第一行为锚点(其中 4 条是超长行)
          chunks = [
            { type: 'stream-start', warnings: [] },
            ...TARGETS.map((path, i) => ({
              type: 'tool-call',
              toolCallId: `cap-${i}`,
              toolName: 'capture_range',
              input: JSON.stringify({ path, start_line: 1 })
            })),
            {
              type: 'finish',
              finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
              usage: {
                inputTokens: {
                  total: 1000,
                  noCache: undefined,
                  cacheRead: undefined,
                  cacheWrite: undefined
                },
                outputTokens: { total: 50, text: 50, reasoning: undefined }
              }
            }
          ]
        } else if (step === 2) {
          // 第二步:从上一步结果里取 anchorId,一次原子改 5 个文件
          const prompt = JSON.stringify(options.prompt)
          const anchorIds = [...prompt.matchAll(/anchorId: ([0-9a-f-]{36})/g)].map((m) => m[1])
          chunks = [
            { type: 'stream-start', warnings: [] },
            {
              type: 'tool-call',
              toolCallId: 'edit-all',
              toolName: 'apply_string_edits',
              input: JSON.stringify({
                operations: anchorIds.map((id, i) => ({
                  type: 'insert_after',
                  anchor_id: id,
                  content: `\\n/* 基准修改 ${i} */`
                }))
              })
            },
            {
              type: 'finish',
              finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
              usage: {
                inputTokens: {
                  total: 2000,
                  noCache: undefined,
                  cacheRead: undefined,
                  cacheWrite: undefined
                },
                outputTokens: { total: 80, text: 80, reasoning: undefined }
              }
            }
          ]
        } else {
          chunks = [
            { type: 'stream-start', warnings: [] },
            { type: 'text-start', id: '0' },
            { type: 'text-delta', id: '0', delta: '五个文件已按锚点原子修改完成。' },
            { type: 'text-end', id: '0' },
            {
              type: 'finish',
              finishReason: { unified: 'stop', raw: 'stop' },
              usage: {
                inputTokens: {
                  total: 500,
                  noCache: undefined,
                  cacheRead: undefined,
                  cacheWrite: undefined
                },
                outputTokens: { total: 30, text: 30, reasoning: undefined }
              }
            }
          ]
        }
        return { stream: simulateReadableStream({ chunks: chunks as V3StreamPart[] }) }
      }
    })

    const result = streamText({
      model,
      tools,
      messages: [{ role: 'user', content: '给五个 RBAC 文件都加上基准注释' }],
      stopWhen: () => governor.shouldStop()
    })
    for await (const part of result.fullStream) {
      if (part.type === 'error') throw part.error
      if (part.type === 'tool-result' && typeof part.output === 'string') {
        toolResults.push(part.output)
      }
    }

    // 五个文件全部改到
    for (const path of TARGETS) {
      expect(vfs.raw(path).content).toContain('基准修改')
    }
    // 不发生截断复述导致的 MATCH_NOT_FOUND
    expect(toolResults.join('\n')).not.toContain('MATCH_NOT_FOUND')
    // 同一错误不得连续出现两次(这里应当一次失败都没有)
    const failures = toolResults.filter((r) => r.startsWith('错误'))
    expect(new Set(failures).size).toBe(failures.length)
    // 编辑失败率 < 5%
    expect(failures.length).toBe(0)
    // 单轮调用数远低于 20 的软阈值
    expect(gate.count()).toBeLessThanOrEqual(20)

    console.info(`[bench] 编排:${gate.count()} 次工具调用,${failures.length} 次失败`)
  })

  it('硬上限:超发的并行调用被同步闸门拒绝且无副作用', async () => {
    const vfs = new SessionVfs(loadFixture())
    const ledger = new RunContextLedger()
    const hard = resolveToolLimits(DEFAULT_TOOL_CALL_LIMIT).hard
    const gate = new ToolBudgetGate(hard)
    const tools = wrapToolsWithBudget(
      buildFileTools(vfs, { onPatch: () => {}, onDelete: () => {} }, { ledger }),
      gate
    )
    for (let i = 0; i < hard - 1; i++) gate.reserve(`pre-${i}`)

    const write = tools.write_file as {
      execute: (input: unknown, opts: unknown) => Promise<unknown>
    }
    const results = await Promise.all([
      write.execute(
        { path: 'rbac/new-a.css', content: '.a{}' },
        { toolCallId: 'burst-1', messages: [] }
      ),
      write.execute(
        { path: 'rbac/new-b.css', content: '.b{}' },
        { toolCallId: 'burst-2', messages: [] }
      )
    ])

    const rejected = results.filter((r) => String(r).includes('TOOL_BUDGET_EXCEEDED'))
    expect(rejected).toHaveLength(1)
    // 被拒的那个没有任何副作用
    const created = ['rbac/new-a.css', 'rbac/new-b.css'].filter((p) => vfs.has(p))
    expect(created).toHaveLength(1)
    expect(gate.count()).toBe(hard)
  })
})
