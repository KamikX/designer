import { describe, expect, it } from 'vitest'
import {
  addDetailedUsage,
  emptyDetailedUsage,
  extractProviderTotalTokens,
  normalizeStepUsage
} from './usage'

describe('normalizeStepUsage', () => {
  it('完整上报时逐字段透传并全部标记 reported', () => {
    expect(
      normalizeStepUsage({
        inputTokens: 100,
        inputTokenDetails: { noCacheTokens: 60, cacheReadTokens: 40, cacheWriteTokens: undefined },
        outputTokens: 20,
        outputTokenDetails: { textTokens: 12, reasoningTokens: 8 },
        totalTokens: 120
      })
    ).toMatchObject({
      inputTokens: 100,
      noCacheTokens: 60,
      cacheReadTokens: 40,
      cacheWriteTokens: null,
      outputTokens: 20,
      textTokens: 12,
      reasoningTokens: 8,
      totalTokens: 120,
      reported: {
        inputTokens: true,
        noCacheTokens: true,
        cacheReadTokens: true,
        cacheWriteTokens: false,
        outputTokens: true,
        textTokens: true,
        reasoningTokens: true,
        totalTokens: true
      }
    })
  })

  it('明确上报的 0 与未上报是两回事', () => {
    const usage = normalizeStepUsage({
      inputTokens: 0,
      inputTokenDetails: {
        noCacheTokens: undefined,
        cacheReadTokens: 0,
        cacheWriteTokens: undefined
      },
      outputTokens: 0,
      outputTokenDetails: { textTokens: undefined, reasoningTokens: undefined },
      totalTokens: undefined
    })
    expect(usage.inputTokens).toBe(0)
    expect(usage.cacheReadTokens).toBe(0)
    expect(usage.reported.inputTokens).toBe(true)
    expect(usage.reported.cacheReadTokens).toBe(true)
    // 未上报的字段必须是 null,不许坍缩成 0
    expect(usage.noCacheTokens).toBeNull()
    expect(usage.totalTokens).toBeNull()
    expect(usage.reported.noCacheTokens).toBe(false)
    expect(usage.reported.totalTokens).toBe(false)
  })

  it('细节对象整体缺失时全部保持未上报', () => {
    const usage = normalizeStepUsage({
      inputTokens: 10,
      outputTokens: 5
    } as never)
    expect(usage.inputTokens).toBe(10)
    expect(usage.noCacheTokens).toBeNull()
    expect(usage.cacheReadTokens).toBeNull()
    expect(usage.textTokens).toBeNull()
    expect(usage.reported.cacheReadTokens).toBe(false)
  })

  it('usage 整个缺失时返回全 null 全未上报', () => {
    const usage = normalizeStepUsage(undefined)
    expect(usage.inputTokens).toBeNull()
    expect(usage.outputTokens).toBeNull()
    expect(usage.providerTotalTokens).toBeNull()
    expect(Object.values(usage.reported).every((v) => v === false)).toBe(true)
  })

  it('非法数值(负数/NaN/非数字)按未上报处理', () => {
    const usage = normalizeStepUsage({
      inputTokens: -1,
      inputTokenDetails: {
        noCacheTokens: Number.NaN,
        cacheReadTokens: '40' as never,
        cacheWriteTokens: undefined
      },
      outputTokens: 3.7 as never,
      outputTokenDetails: { textTokens: undefined, reasoningTokens: undefined },
      totalTokens: Number.POSITIVE_INFINITY
    })
    expect(usage.inputTokens).toBeNull()
    expect(usage.noCacheTokens).toBeNull()
    expect(usage.cacheReadTokens).toBeNull()
    expect(usage.totalTokens).toBeNull()
    // 小数向下取整仍算上报(有些网关会返回小数)
    expect(usage.outputTokens).toBe(3)
    expect(usage.reported.outputTokens).toBe(true)
  })

  it('识别 openai 兼容 raw 的 total_tokens 并且不保留 raw 本身', () => {
    const usage = normalizeStepUsage(
      {
        inputTokens: 100,
        inputTokenDetails: {
          noCacheTokens: undefined,
          cacheReadTokens: undefined,
          cacheWriteTokens: undefined
        },
        outputTokens: 20,
        outputTokenDetails: { textTokens: undefined, reasoningTokens: undefined },
        totalTokens: 120,
        raw: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 121 }
      },
      { adapter: 'openai-compatible' }
    )
    expect(usage.providerTotalTokens).toBe(121)
    expect(usage.reported.providerTotalTokens).toBe(true)
    // SDK 归一化合计与 provider 原始值分离保存
    expect(usage.totalTokens).toBe(120)
    expect('raw' in usage).toBe(false)
  })

  it('未识别的 raw 形状保持未上报,不猜测', () => {
    const usage = normalizeStepUsage(
      {
        inputTokens: 10,
        inputTokenDetails: {
          noCacheTokens: undefined,
          cacheReadTokens: undefined,
          cacheWriteTokens: undefined
        },
        outputTokens: 2,
        outputTokenDetails: { textTokens: undefined, reasoningTokens: undefined },
        totalTokens: 12,
        raw: { weird: { nested: 999 } }
      },
      { adapter: 'openai-compatible' }
    )
    expect(usage.providerTotalTokens).toBeNull()
    expect(usage.reported.providerTotalTokens).toBe(false)
  })
})

describe('extractProviderTotalTokens', () => {
  it('openai 系列适配器提取白名单的 total_tokens', () => {
    expect(extractProviderTotalTokens('openai', { total_tokens: 42 })).toBe(42)
    expect(extractProviderTotalTokens('openai-compatible', { total_tokens: 42 })).toBe(42)
    expect(extractProviderTotalTokens('deepseek', { total_tokens: 42 })).toBe(42)
  })

  it('兼容网关把用量再包一层 usage 的形状', () => {
    expect(extractProviderTotalTokens('openai-compatible', { usage: { total_tokens: 7 } })).toBe(7)
  })

  it('anthropic 原始用量没有总量字段,由 input+output 白名单求和', () => {
    expect(extractProviderTotalTokens('anthropic', { input_tokens: 30, output_tokens: 12 })).toBe(
      42
    )
    // 缺任何一半都不能硬算
    expect(extractProviderTotalTokens('anthropic', { input_tokens: 30 })).toBeNull()
  })

  it('google 提取 totalTokenCount', () => {
    expect(extractProviderTotalTokens('google', { totalTokenCount: 55 })).toBe(55)
  })

  it('不认识的形状与非法数值一律返回 null', () => {
    expect(extractProviderTotalTokens('openai', { total_tokens: '42' })).toBeNull()
    expect(extractProviderTotalTokens('openai', { total_tokens: -1 })).toBeNull()
    expect(extractProviderTotalTokens('openai', null)).toBeNull()
    expect(extractProviderTotalTokens('openai', undefined)).toBeNull()
    expect(extractProviderTotalTokens('google', { total_tokens: 42 })).toBeNull()
  })
})

describe('addDetailedUsage', () => {
  it('逐字段相加,未上报字段不参与也不污染', () => {
    const a = normalizeStepUsage({
      inputTokens: 100,
      inputTokenDetails: { noCacheTokens: 60, cacheReadTokens: 40, cacheWriteTokens: undefined },
      outputTokens: 20,
      outputTokenDetails: { textTokens: 12, reasoningTokens: 8 },
      totalTokens: 120
    })
    const b = normalizeStepUsage({
      inputTokens: 50,
      inputTokenDetails: {
        noCacheTokens: undefined,
        cacheReadTokens: undefined,
        cacheWriteTokens: 5
      },
      outputTokens: 10,
      outputTokenDetails: { textTokens: undefined, reasoningTokens: undefined },
      totalTokens: undefined
    })
    const sum = addDetailedUsage(a, b)
    expect(sum.inputTokens).toBe(150)
    expect(sum.outputTokens).toBe(30)
    // 单边上报的字段:有值的一边成立
    expect(sum.noCacheTokens).toBe(60)
    expect(sum.cacheReadTokens).toBe(40)
    expect(sum.cacheWriteTokens).toBe(5)
    expect(sum.totalTokens).toBe(120)
    // 只要任意一步上报过,累计值就算上报
    expect(sum.reported.cacheWriteTokens).toBe(true)
    expect(sum.reported.reasoningTokens).toBe(true)
  })

  it('双方都未上报时保持 null', () => {
    const sum = addDetailedUsage(emptyDetailedUsage(), emptyDetailedUsage())
    expect(sum.inputTokens).toBeNull()
    expect(sum.reported.inputTokens).toBe(false)
  })
})
