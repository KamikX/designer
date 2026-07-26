// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { UsageDailyRow, UsageQuery, UsageReport } from '@shared/types'
import { cacheHitRatio, formatMetric, useUsageStore } from './usage'

function row(overrides: Partial<UsageDailyRow> = {}): UsageDailyRow {
  return {
    date: '2026-07-25',
    providerKey: 'prov-1',
    providerSlug: 'openai',
    modelId: 'gpt-test',
    scene: 'design',
    projectKey: 'none',
    projectId: null,
    stepCount: 4,
    runCount: 2,
    inputTokens: 400,
    inputNoCacheTokens: 240,
    cacheReadTokens: 160,
    cacheWriteTokens: 0,
    outputTokens: 80,
    outputTextTokens: 48,
    reasoningTokens: 32,
    sdkTotalTokens: 480,
    providerTotalTokens: 484,
    reportedInputCalls: 4,
    reportedNoCacheCalls: 4,
    reportedCacheReadCalls: 4,
    reportedCacheWriteCalls: 0,
    reportedOutputCalls: 4,
    reportedTextCalls: 4,
    reportedReasoningCalls: 4,
    reportedSdkTotalCalls: 4,
    reportedProviderTotalCalls: 4,
    ...overrides
  }
}

const usageCalls: UsageQuery[] = []
let report: UsageReport = { rows: [] }
const clearUsage = vi.fn()

beforeEach(() => {
  setActivePinia(createPinia())
  usageCalls.length = 0
  clearUsage.mockClear()
  report = { rows: [row()] }
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      observability: {
        usage: async (query: UsageQuery) => {
          usageCalls.push(query)
          return report
        },
        clearUsage
      }
    }
  })
})

describe('查询参数', () => {
  it('日期/provider/model/项目/场景全部透传', async () => {
    const store = useUsageStore()
    await store.load({
      from: '2026-07-20',
      to: '2026-07-25',
      providerKey: 'prov-1',
      modelId: 'gpt-test',
      scene: 'design',
      projectKey: 'project:p1'
    })
    expect(usageCalls[0]).toEqual({
      from: '2026-07-20',
      to: '2026-07-25',
      providerKey: 'prov-1',
      modelId: 'gpt-test',
      scene: 'design',
      projectKey: 'project:p1'
    })
  })

  it('置空的条件从查询里删掉,不发空串', async () => {
    const store = useUsageStore()
    await store.load({ providerKey: 'prov-1' })
    await store.load({ providerKey: undefined, scene: 'chat' })
    expect(usageCalls[1]).toEqual({ scene: 'chat' })
  })

  it('清除用量走 IPC 并刷新', async () => {
    const store = useUsageStore()
    await store.clear()
    expect(clearUsage).toHaveBeenCalledOnce()
    expect(usageCalls).toHaveLength(1)
  })
})

describe('未报告语义', () => {
  it('reported_calls 为 0 时显示"未报告",不显示 0', () => {
    expect(formatMetric(0, 0)).toBe('未报告')
    // 明确上报的 0 就是 0
    expect(formatMetric(0, 3)).toBe('0')
    expect(formatMetric(1234, 3)).toBe('1,234')
  })

  it('缓存命中率:任一边未报告就没有这个指标', () => {
    expect(cacheHitRatio(row())).toBeCloseTo(0.4)
    expect(cacheHitRatio(row({ reportedCacheReadCalls: 0, cacheReadTokens: 0 }))).toBeNull()
    expect(cacheHitRatio(row({ reportedNoCacheCalls: 0, inputNoCacheTokens: 0 }))).toBeNull()
  })
})

describe('汇总', () => {
  it('平均每轮/每次请求 token', async () => {
    const store = useUsageStore()
    await store.load()
    expect(store.totals.runs).toBe(2)
    expect(store.totals.avgInputPerRun).toBe(200)
    expect(store.totals.avgInputPerStep).toBe(100)
  })

  it('没有数据时平均值是 null 而不是除零', async () => {
    report = { rows: [] }
    const store = useUsageStore()
    await store.load()
    expect(store.totals.avgInputPerRun).toBeNull()
  })
})
