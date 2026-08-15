import { describe, expect, it } from 'vitest'
import { inferContextWindow } from './model-caps'

/**
 * 窗口推断的价值在**不错标**:记大了单步请求被 API 拒,记小了 token 熔断
 * 提前一个数量级触发(gpt-5.4-mini 按 64k 记账时动不动就"累计输入超预算")。
 */
describe('inferContextWindow', () => {
  it.each([
    ['gpt-5.4-mini', 400_000],
    ['gpt-5', 400_000],
    ['gpt-4.1', 1_000_000],
    ['gpt-4o', 128_000],
    ['o3-mini', 200_000],
    ['claude-sonnet-4-5', 200_000],
    ['gemini-2.5-pro', 1_000_000],
    ['deepseek-chat', 128_000],
    ['glm-4.6', 128_000],
    ['kimi-k2', 256_000],
    ['qwen3-max', 128_000]
  ])('%s → %d', (id, window) => {
    expect(inferContextWindow(id)).toBe(window)
  })

  it('认不出的家族返回 null,由调用方兜底', () => {
    expect(inferContextWindow('totally-unknown-model')).toBeNull()
  })

  it('pro 不会被误判成 o 系列', () => {
    expect(inferContextWindow('some-pro-model')).toBeNull()
  })
})
