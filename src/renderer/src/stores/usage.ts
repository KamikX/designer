import { t } from '@renderer/i18n'
import { defineStore } from 'pinia'
import type { UsageDailyRow, UsageQuery } from '@shared/types'

/**
 * 模型用量页的状态。
 *
 * 数据是长期日聚合(主进程 SQLite),这里只管查询参数与派生指标。
 * 核心纪律:**未报告 ≠ 0**——和数列与 reported_calls 成对,reported 为 0
 * 时必须显示"未报告",否则没上报缓存的 provider 会把命中率拉成假 0。
 */

/** 和数 + 上报次数 → 展示文本。未报告的指标不许冒充 0 */
export function formatMetric(sum: number, reportedCalls: number): string {
  return reportedCalls === 0 ? t('common.notReported') : sum.toLocaleString()
}

/** 缓存命中率:read / (read + noCache)。任一边没报就没有这个指标 */
export function cacheHitRatio(row: UsageDailyRow): number | null {
  if (row.reportedCacheReadCalls === 0 || row.reportedNoCacheCalls === 0) return null
  const denominator = row.cacheReadTokens + row.inputNoCacheTokens
  if (denominator === 0) return 0
  return row.cacheReadTokens / denominator
}

export const useUsageStore = defineStore('usage', {
  state: () => ({
    rows: [] as UsageDailyRow[],
    loading: false,
    query: {} as UsageQuery
  }),

  getters: {
    /** 全表汇总,给页面顶部的统计牌 */
    totals(): {
      runs: number
      steps: number
      inputTokens: number
      outputTokens: number
      avgInputPerRun: number | null
      avgInputPerStep: number | null
    } {
      const runs = this.rows.reduce((n, r) => n + r.runCount, 0)
      const steps = this.rows.reduce((n, r) => n + r.stepCount, 0)
      const inputTokens = this.rows.reduce((n, r) => n + r.inputTokens, 0)
      const outputTokens = this.rows.reduce((n, r) => n + r.outputTokens, 0)
      return {
        runs,
        steps,
        inputTokens,
        outputTokens,
        avgInputPerRun: runs > 0 ? Math.round(inputTokens / runs) : null,
        avgInputPerStep: steps > 0 ? Math.round(inputTokens / steps) : null
      }
    }
  },

  actions: {
    /** 合并查询条件并重新拉取。传 undefined 的键会被清掉 */
    async load(patch?: Partial<UsageQuery>): Promise<void> {
      if (patch) {
        const next = { ...this.query, ...patch }
        for (const key of Object.keys(next) as (keyof UsageQuery)[]) {
          if (next[key] === undefined || next[key] === '') delete next[key]
        }
        this.query = next
      }
      this.loading = true
      try {
        // 展开成纯对象:IPC 是 structured clone,响应式代理传不过去
        const report = await window.api.observability.usage({ ...this.query })
        this.rows = report.rows
      } finally {
        this.loading = false
      }
    },

    /** 清除长期用量(主进程同事务清日表与桥表),然后刷新 */
    async clear(): Promise<void> {
      await window.api.observability.clearUsage()
      await this.load()
    }
  }
})
