import { describe, expect, it } from 'vitest'
import type { ModelMessage } from 'ai'
import { withCacheBreakpoints } from './prompt-cache'

/**
 * 缓存断点错了不会报错,只会表现成"账单没变、命中率是 0"——最难发现的一类问题。
 * 这里钉住三件事:只对 anthropic 生效、最后一条必标、长回合里按 20 块窗口补中间断点。
 */

function user(text: string): ModelMessage {
  return { role: 'user', content: text }
}

/** 一步并行 n 个工具调用:assistant(n 个 tool-call) + tool(n 个 result) */
function toolStep(n: number): ModelMessage[] {
  return [
    {
      role: 'assistant',
      content: Array.from({ length: n }, (_, i) => ({
        type: 'tool-call' as const,
        toolCallId: `c${i}`,
        toolName: 'read_file',
        input: {}
      }))
    },
    {
      role: 'tool',
      content: Array.from({ length: n }, (_, i) => ({
        type: 'tool-result' as const,
        toolCallId: `c${i}`,
        toolName: 'read_file',
        output: { type: 'text' as const, value: 'ok' }
      }))
    }
  ]
}

function markedIndexes(messages: ModelMessage[]): number[] {
  return messages.flatMap((message, index) =>
    (message.providerOptions?.anthropic as { cacheControl?: unknown } | undefined)?.cacheControl
      ? [index]
      : []
  )
}

describe('withCacheBreakpoints', () => {
  it('非 anthropic 适配器原样返回:OpenAI 那边是服务端自动缓存,不认这个字段', () => {
    const messages = [user('改一下')]
    expect(withCacheBreakpoints(messages, 'openai')).toBe(messages)
    expect(withCacheBreakpoints(messages, 'openai-compatible')).toBe(messages)
    expect(withCacheBreakpoints(messages, undefined)).toBe(messages)
  })

  it('不改入参,只返回新数组', () => {
    const messages = [user('改一下')]
    const out = withCacheBreakpoints(messages, 'anthropic')
    expect(out).not.toBe(messages)
    expect(messages[0].providerOptions).toBeUndefined()
    expect(out[0].providerOptions?.anthropic).toEqual({ cacheControl: { type: 'ephemeral' } })
  })

  it('短对话:最后一条必被标上(多轮对话的标准打法)', () => {
    const out = withCacheBreakpoints([user('a'), user('b')], 'anthropic')
    expect(markedIndexes(out)).toEqual([1])
  })

  it('长回合按 20 块窗口补中间断点,不是只标最后一条', () => {
    // 6 步 × 每步 5 个并行调用 = 12 条消息、60 个 block
    const messages = [user('做一版后台'), ...Array.from({ length: 6 }, () => toolStep(5)).flat()]
    const marks = markedIndexes(withCacheBreakpoints(messages, 'anthropic'))

    expect(marks.length).toBeGreaterThan(1)
    // 相邻断点之间的块数必须小于 20 的硬窗口,否则下一次请求够不着上一次的条目
    const blocksBetween = (from: number, to: number): number =>
      messages
        .slice(from + 1, to + 1)
        .reduce((n, m) => n + (Array.isArray(m.content) ? m.content.length : 1), 0)
    for (let i = 1; i < marks.length; i++) {
      expect(blocksBetween(marks[i - 1], marks[i])).toBeLessThan(20)
    }
  })

  it('断点数不超过 anthropic 的 4 个上限:超了会被 provider 静默丢掉', () => {
    const messages = [user('起'), ...Array.from({ length: 40 }, () => toolStep(4)).flat()]
    expect(markedIndexes(withCacheBreakpoints(messages, 'anthropic')).length).toBeLessThanOrEqual(4)
  })

  it('保留已有的 providerOptions,不把别的 provider 参数冲掉', () => {
    const messages: ModelMessage[] = [
      { role: 'user', content: 'x', providerOptions: { openai: { store: false } } }
    ]
    const out = withCacheBreakpoints(messages, 'anthropic')
    expect(out[0].providerOptions?.openai).toEqual({ store: false })
    expect(out[0].providerOptions?.anthropic).toEqual({ cacheControl: { type: 'ephemeral' } })
  })
})
