import { APICallError, streamText } from 'ai'
import { MockLanguageModelV3, simulateReadableStream } from 'ai/test'
import { describe, expect, it } from 'vitest'

/**
 * 钉住 chat-service 赖以成立的一条 SDK 行为。
 *
 * `textStream` 出错会 reject,`fullStream` **不会**——它把错误当成一个
 * `{ type: 'error' }` part 发出来,然后流正常结束。当初从 textStream 换到
 * fullStream 时漏了这点,于是上游 502 被静默吞掉:循环跑完、按"完成"落库、
 * 界面上什么都不显示,表现成"聊到一半自己停了"。
 *
 * 所以这里测的不是我们的代码,是**我们的假设**:哪天 SDK 升级改了语义,
 * 这个测试会先响,而不是等用户又遇到一次无声的中断。
 */

function erroringModel(error: unknown): MockLanguageModelV3 {
  return new MockLanguageModelV3({
    doStream: async () => ({
      stream: simulateReadableStream({
        chunks: [
          { type: 'stream-start', warnings: [] },
          { type: 'text-start', id: '0' },
          { type: 'text-delta', id: '0', delta: '我先写点东西' },
          { type: 'error', error }
        ]
      })
    })
  })
}

const upstream502 = new APICallError({
  message: 'Upstream request failed',
  url: 'https://cc.antdv-pro.cn/responses',
  requestBodyValues: {},
  statusCode: 502,
  responseBody: '{"error":{"message":"Upstream request failed","type":"upstream_error"}}',
  isRetryable: false
})

describe('fullStream 的错误语义', () => {
  it('错误是 part,不是 rejection——遍历本身不抛', async () => {
    const result = streamText({ model: erroringModel(upstream502), prompt: '写个页面' })

    const types: string[] = []
    // 关键:这个 for-await 如果会抛,老代码的 try/catch 本来就接得住,
    // 也就不会有那个 bug。它不抛,才是问题所在
    for await (const part of result.fullStream) types.push(part.type)

    expect(types).toContain('error')
  })

  it('错误 part 里带着原始错误,状态码没丢', async () => {
    const result = streamText({ model: erroringModel(upstream502), prompt: '写个页面' })

    let caught: unknown = null
    for await (const part of result.fullStream) {
      if (part.type === 'error') caught = part.error
    }

    expect(APICallError.isInstance(caught)).toBe(true)
    expect((caught as APICallError).statusCode).toBe(502)
  })

  it('出错前已经吐出的文字仍在流里——那部分内容不该被丢掉', async () => {
    const result = streamText({ model: erroringModel(upstream502), prompt: '写个页面' })

    let text = ''
    for await (const part of result.fullStream) {
      if (part.type === 'text-delta') text += part.text
    }

    expect(text).toBe('我先写点东西')
  })
})
