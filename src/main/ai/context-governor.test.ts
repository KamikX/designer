import { describe, expect, it, vi } from 'vitest'
import type { ModelMessage } from 'ai'
import {
  ContextGovernor,
  ToolBudgetGate,
  effectiveToolCallLimit,
  resolveToolLimits,
  wrapToolsWithBudget
} from './context-governor'
import { RunContextLedger } from './run-context-ledger'
import { normalizeStepUsage } from './usage'

/**
 * 分级预算按硬上限等比派生(50% 软阈值强制压缩+合并指引、75% 禁止重读
 * 未变化文件、100% 硬上限);累计输入 3× 上下文窗口强压缩、5× 结束。
 * 用例仍按上限 40 写,读起来就是原来的 20 / 30 / 40。
 * stopWhen 挡不住单个 step 一次吐超额并行调用,所以所有 execute 外层
 * 共用同步的 ToolBudgetGate.reserve。
 */

function governorWith(
  toolCalls: number,
  contextWindow = 64_000,
  limit = 40
): {
  governor: ContextGovernor
  ledger: RunContextLedger
  gate: ToolBudgetGate
} {
  const ledger = new RunContextLedger()
  const limits = resolveToolLimits(limit)
  const gate = new ToolBudgetGate(limits.hard)
  for (let i = 0; i < toolCalls; i++) gate.reserve(`c${i}`)
  const governor = new ContextGovernor({ ledger, gate, contextWindow, limits })
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

describe('可配置的工具预算', () => {
  it('三档阈值按硬上限等比缩放', () => {
    expect(resolveToolLimits(40)).toEqual({ hard: 40, soft: 20, noReread: 30 })
    expect(resolveToolLimits(200)).toEqual({ hard: 200, soft: 100, noReread: 150 })
    // 上限调高之后不该还在第 20 次就压缩历史
    expect(
      governorWith(20, 64_000, 200).governor.prepareStep({
        messages: MESSAGES,
        serializedChars: 1000
      }).messages
    ).toBeUndefined()
  })

  it('0 = 不限:调用不被拦,只剩 token 窗口那条熔断', async () => {
    const limits = resolveToolLimits(0)
    expect(limits.hard).toBe(Infinity)
    // 软阈值与禁重读不跟着消失——它们防的是上下文膨胀,不是次数
    expect(limits.soft).toBe(20)
    expect(limits.noReread).toBe(30)

    const { governor, ledger, gate } = governorWith(500, 1000, 0)
    expect(governor.shouldStop()).toBe(false)
    const execute = vi.fn(async () => 'ok')
    const wrapped = wrapToolsWithBudget({ t: { description: '', execute } } as never, gate)
    await (wrapped.t as { execute: (i: unknown, o: unknown) => Promise<unknown> }).execute(
      {},
      { toolCallId: 'more' }
    )
    expect(execute).toHaveBeenCalled()

    // token 熔断照旧:5× 窗口
    ledger.addUsage(
      normalizeStepUsage({
        inputTokens: 5000,
        inputTokenDetails: {
          noCacheTokens: undefined,
          cacheReadTokens: undefined,
          cacheWriteTokens: undefined
        },
        outputTokens: 1,
        outputTokenDetails: { textTokens: undefined, reasoningTokens: undefined },
        totalTokens: 5001
      })
    )
    expect(governor.shouldStop()).toBe(true)
  })

  /*
   * 熔断守的是花费:cache read 计费约 1 折。全价累计的话,开着前缀缓存的
   * 长轮次照样被判超预算——账面超了,钱包没超。
   */
  it('缓存命中按 1 折计入累计输入', () => {
    const { governor, ledger } = governorWith(0, 1000)
    // 全量 6000,其中 5000 是缓存命中:成本口径 = 1000 + 5000×0.1 = 1500 < 5000
    ledger.addUsage(
      normalizeStepUsage({
        inputTokens: 6000,
        inputTokenDetails: {
          noCacheTokens: 1000,
          cacheReadTokens: 5000,
          cacheWriteTokens: undefined
        },
        outputTokens: 10,
        outputTokenDetails: { textTokens: undefined, reasoningTokens: undefined },
        totalTokens: 6010
      })
    )
    expect(governor.cumulativeInputTokens().value).toBe(1500)
    expect(governor.shouldStop()).toBe(false)
  })

  it('压缩提示与收尾文案说的是真实上限', () => {
    const compact = governorWith(100, 64_000, 200).governor.prepareStep({
      messages: MESSAGES,
      serializedChars: 1000
    })
    expect(JSON.stringify(compact.messages)).toContain('硬上限 200 次')
    expect(governorWith(0, 64_000, 200).governor.hardLimitText()).toBe('200 次')
    expect(governorWith(0, 64_000, 0).governor.hardLimitText()).toBe('不限次数')
  })

  it('项目覆盖优先于全局,0 能穿过去,没设过才落全局', () => {
    expect(effectiveToolCallLimit(120, 80)).toBe(120)
    // 0 是"明确要不限",不能被当成 falsy 吞掉
    expect(effectiveToolCallLimit(0, 80)).toBe(0)
    expect(effectiveToolCallLimit(null, 80)).toBe(80)
    expect(effectiveToolCallLimit(undefined, 0)).toBe(0)
    // 两边都没有(老配置文件)退回默认值
    expect(effectiveToolCallLimit(null, undefined)).toBe(80)
    // 负数是脏数据,当没设过
    expect(effectiveToolCallLimit(-5, 80)).toBe(80)
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
