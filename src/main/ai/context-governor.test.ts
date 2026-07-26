import { describe, expect, it, vi } from 'vitest'
import type { ModelMessage } from 'ai'
import { ContextGovernor, ToolBudgetGate, wrapToolsWithBudget } from './context-governor'
import { RunContextLedger } from './run-context-ledger'
import { normalizeStepUsage } from './usage'

/**
 * 分级预算:20 软阈值(强制压缩+合并指引)、30 禁止重读未变化文件、
 * 40 硬上限;累计输入 3× 上下文窗口强压缩、5× 结束。
 * stopWhen 挡不住单个 step 一次吐超额并行调用,所以所有 execute 外层
 * 共用同步的 ToolBudgetGate.reserve。
 */

function governorWith(
  toolCalls: number,
  contextWindow = 64_000
): {
  governor: ContextGovernor
  ledger: RunContextLedger
  gate: ToolBudgetGate
} {
  const ledger = new RunContextLedger()
  const gate = new ToolBudgetGate(40)
  for (let i = 0; i < toolCalls; i++) gate.reserve(`c${i}`)
  const governor = new ContextGovernor({ ledger, gate, contextWindow })
  return { governor, ledger, gate }
}

const MESSAGES: ModelMessage[] = [{ role: 'user', content: '改一下页面' }]

describe('分级工具预算', () => {
  it('20 次触发压缩与合并指引', () => {
    const { governor } = governorWith(20)
    const result = governor.prepareStep({ messages: MESSAGES, serializedChars: 1000 })
    expect(result.messages).toBeDefined()
    const text = JSON.stringify(result.messages)
    expect(text).toContain('合并')
    // 工具 schema 保持稳定:不缩减 activeTools
    expect('activeTools' in result).toBe(false)
  })

  it('20 次以下不动消息', () => {
    const { governor } = governorWith(5)
    const result = governor.prepareStep({ messages: MESSAGES, serializedChars: 1000 })
    expect(result.messages).toBeUndefined()
  })

  it('30 次后禁止重读未变化的文件', () => {
    const { governor, ledger } = governorWith(30)
    ledger.noteRead('a.vue', 2)
    expect(governor.readGate('a.vue', 2)).toContain('未变化')
    // 修订变了可以再读
    expect(governor.readGate('a.vue', 3)).toBeNull()
    // 30 次以下不拦
    const fresh = governorWith(5)
    fresh.ledger.noteRead('a.vue', 2)
    expect(fresh.governor.readGate('a.vue', 2)).toBeNull()
  })

  it('40 次硬上限停止后续 step', () => {
    expect(governorWith(39).governor.shouldStop()).toBe(false)
    expect(governorWith(40).governor.shouldStop()).toBe(true)
  })
})

describe('ToolBudgetGate 同步预留', () => {
  it('单个并行 step 只放行剩余名额,读写一视同仁', async () => {
    const gate = new ToolBudgetGate(40)
    for (let i = 0; i < 38; i++) gate.reserve(`c${i}`)

    const executed: string[] = []
    const tools = {
      read_file: {
        description: 'r',
        execute: async () => {
          executed.push('read')
          return 'ok'
        }
      },
      write_file: {
        description: 'w',
        execute: async () => {
          executed.push('write')
          return 'ok'
        }
      }
    }
    const wrapped = wrapToolsWithBudget(tools as never, gate)

    // 一步并行来 3 个调用(2 读 1 写),只剩 2 个名额
    const results = await Promise.all([
      (wrapped.read_file as { execute: (i: unknown, o: unknown) => Promise<unknown> }).execute(
        {},
        { toolCallId: 'p1' }
      ),
      (wrapped.write_file as { execute: (i: unknown, o: unknown) => Promise<unknown> }).execute(
        {},
        { toolCallId: 'p2' }
      ),
      (wrapped.read_file as { execute: (i: unknown, o: unknown) => Promise<unknown> }).execute(
        {},
        { toolCallId: 'p3' }
      )
    ])

    expect(executed).toHaveLength(2)
    const rejected = results.filter((r) => String(r).includes('TOOL_BUDGET_EXCEEDED'))
    expect(rejected).toHaveLength(1)
  })

  it('同一 callId 重复 reserve 不重复占名额', () => {
    const gate = new ToolBudgetGate(40)
    expect(gate.reserve('x')).toBe(true)
    expect(gate.reserve('x')).toBe(true)
    expect(gate.count()).toBe(1)
  })

  it('超额调用不触发底层 execute(无副作用)', async () => {
    const gate = new ToolBudgetGate(1)
    gate.reserve('used')
    const execute = vi.fn(async () => 'ok')
    const wrapped = wrapToolsWithBudget({ t: { description: '', execute } } as never, gate)
    const out = await (
      wrapped.t as { execute: (i: unknown, o: unknown) => Promise<unknown> }
    ).execute({}, { toolCallId: 'over' })
    expect(execute).not.toHaveBeenCalled()
    expect(String(out)).toContain('TOOL_BUDGET_EXCEEDED')
  })
})

describe('token 预算', () => {
  it('已上报的输入用量优先,3× 窗口强制压缩', () => {
    const { governor, ledger } = governorWith(0, 1000)
    ledger.addUsage(
      normalizeStepUsage({
        inputTokens: 3100,
        inputTokenDetails: {
          noCacheTokens: undefined,
          cacheReadTokens: undefined,
          cacheWriteTokens: undefined
        },
        outputTokens: 10,
        outputTokenDetails: { textTokens: undefined, reasoningTokens: undefined },
        totalTokens: 3110
      })
    )
    expect(governor.usageEstimated()).toBe(false)
    const result = governor.prepareStep({ messages: MESSAGES, serializedChars: 10 })
    expect(result.messages).toBeDefined()
  })

  it('5× 窗口后结束(保留已完成的写)', () => {
    const { governor, ledger } = governorWith(0, 1000)
    ledger.addUsage(
      normalizeStepUsage({
        inputTokens: 5100,
        inputTokenDetails: {
          noCacheTokens: undefined,
          cacheReadTokens: undefined,
          cacheWriteTokens: undefined
        },
        outputTokens: 10,
        outputTokenDetails: { textTokens: undefined, reasoningTokens: undefined },
        totalTokens: 5110
      })
    )
    expect(governor.shouldStop()).toBe(true)
  })

  it('用量缺失时按 ceil(chars/2) 估算并标记 estimated', () => {
    const { governor } = governorWith(0, 1000)
    governor.prepareStep({ messages: MESSAGES, serializedChars: 6001 })
    expect(governor.usageEstimated()).toBe(true)
    // 6001/2 = 3001 > 3×1000 → 该压缩了
    const result = governor.prepareStep({ messages: MESSAGES, serializedChars: 6001 })
    expect(result.messages).toBeDefined()
    // 估算不进"已上报"口径
    expect(governor.cumulativeInputTokens().reported).toBe(false)
  })
})
