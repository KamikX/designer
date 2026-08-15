import { beforeEach, describe, expect, it, vi } from 'vitest'
import { reasoningRequestOptions } from './provider-options'
import { readConfig } from '../config'
import type { AppConfig } from '../../shared/types'

vi.mock('../config', () => ({ readConfig: vi.fn() }))

const mockConfig = (effort: AppConfig['reasoningEffort'] | undefined): void => {
  vi.mocked(readConfig).mockReturnValue({
    openaiCompat: { store: false, encryptedReasoning: false },
    reasoningEffort: effort
  } as AppConfig)
}

describe('reasoningRequestOptions', () => {
  beforeEach(() => vi.clearAllMocks())

  it('off(默认)一个字段都不发,任何供应商都一样', () => {
    mockConfig('off')
    for (const adapter of ['openai', 'anthropic', 'google', 'deepseek', 'custom', null]) {
      expect(reasoningRequestOptions(adapter)).toEqual({ providerOptions: {} })
    }
  })

  it('老配置文件没有这个键时按 off 处理', () => {
    mockConfig(undefined)
    expect(reasoningRequestOptions('anthropic')).toEqual({ providerOptions: {} })
  })

  it('anthropic 映射 thinking 预算并连带抬高输出上限', () => {
    mockConfig('medium')
    const out = reasoningRequestOptions('anthropic')
    expect(out.providerOptions.anthropic).toEqual({
      thinking: { type: 'enabled', budgetTokens: 8192 }
    })
    // max_tokens 必须大于 thinking 预算,否则 API 直接拒
    expect(out.maxOutputTokens).toBeGreaterThan(8192)
  })

  it('openai 映射 reasoningEffort', () => {
    mockConfig('high')
    expect(reasoningRequestOptions('openai')).toEqual({
      providerOptions: { openai: { reasoningEffort: 'high' } }
    })
  })

  it('google 映射 thinkingConfig', () => {
    mockConfig('low')
    expect(reasoningRequestOptions('google')).toEqual({
      providerOptions: { google: { thinkingConfig: { thinkingBudget: 2048 } } }
    })
  })

  it('deepseek 与自定义中转不发非标字段', () => {
    mockConfig('high')
    expect(reasoningRequestOptions('deepseek')).toEqual({ providerOptions: {} })
    expect(reasoningRequestOptions('my-relay')).toEqual({ providerOptions: {} })
  })
})
