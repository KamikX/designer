import { APICallError, RetryError, streamText } from 'ai'
import { describe, expect, it } from 'vitest'
// 经 registry 再导出引入:顺带钉住"搬家后老引用方不用改"这件事
import { errorMessage, isTransientAiError } from './registry'

/**
 * 这段文案是用户在出错时**唯一**能看到的东西,所以它得回答一个问题:
 * "我该改配置,还是该重试?"
 *
 * 真实案例:网关返回 502 upstream_error,原来只显示 "Upstream request
 * failed",用户据此以为是 Base URL 少了 /v1,去改了配置——方向完全错了。
 */

function apiError(statusCode: number, body: string): APICallError {
  return new APICallError({
    message: 'Upstream request failed',
    url: 'https://example.com/responses',
    requestBodyValues: {},
    statusCode,
    responseBody: body
  })
}

const UPSTREAM_502 = '{"error":{"message":"Upstream request failed","type":"upstream_error"}}'

describe('状态码分流', () => {
  it('502 明说是上游的事,别让用户去翻自己的配置', () => {
    const out = errorMessage(apiError(502, UPSTREAM_502))
    expect(out).toContain('上游')
    expect(out).toContain('不是本地配置')
    expect(out).toContain('502')
  })

  it('401 指向供应商配置', () => {
    expect(errorMessage(apiError(401, '{}'))).toContain('API Key')
  })

  it('404 才提 /v1——路径问题只在这个码下才是合理猜测', () => {
    expect(errorMessage(apiError(404, '{}'))).toContain('/v1')
  })

  it('502 不该提 /v1,那是误导', () => {
    expect(errorMessage(apiError(502, UPSTREAM_502))).not.toContain('/v1')
  })

  it('没有对应文案的状态码也要带上码值,不能只剩原文', () => {
    expect(errorMessage(apiError(418, '{}'))).toContain('418')
  })
})

describe('响应体解析', () => {
  it('挖出 error.message,不把整段 JSON 甩给用户', () => {
    const out = errorMessage(apiError(429, '{"error":{"message":"rate limited"}}'))
    expect(out).toContain('rate limited')
    expect(out).not.toContain('{"error"')
  })

  it('响应体不是 JSON 时退回 SDK 的 message,不抛', () => {
    expect(errorMessage(apiError(500, '<html>bad gateway</html>'))).toContain(
      'Upstream request failed'
    )
  })
})

describe('重试耗尽', () => {
  it('穿透到 lastError——外层的"试了 N 次"本身不含任何信息', () => {
    const inner = apiError(502, UPSTREAM_502)
    const out = errorMessage(
      new RetryError({
        message: 'Failed after 3 attempts',
        reason: 'maxRetriesExceeded',
        errors: [inner, inner, inner]
      })
    )
    expect(out).toContain('重试 3 次')
    expect(out).toContain('上游')
  })
})

describe('流中途的裸错误对象', () => {
  // 真实案例:中转站读上游失败。HTTP 已经 200,错误作为 SSE 事件回流,
  // SDK 原样透传这个非 Error 对象
  const STREAM_ERROR = {
    type: 'error',
    sequence_number: 0,
    error: { type: 'upstream_error', code: 'stream_read_error', message: 'stream_read_error' }
  }

  it('挖出嵌套的 message/type,不显示 [object Object]', () => {
    const out = errorMessage(STREAM_ERROR)
    expect(out).toContain('stream_read_error')
    expect(out).toContain('upstream_error')
    expect(out).not.toContain('object Object')
  })

  it('平铺形态(没有再包一层 error)也能读', () => {
    const out = errorMessage({ type: 'overloaded_error', message: 'Overloaded' })
    expect(out).toContain('Overloaded')
    expect(out).not.toContain('object Object')
  })
})

describe('isTransientAiError:重试与否的分界线', () => {
  it('流中途的 upstream_error 事件判为瞬时', () => {
    expect(
      isTransientAiError({
        type: 'error',
        error: { type: 'upstream_error', code: 'stream_read_error', message: 'stream_read_error' }
      })
    ).toBe(true)
  })

  it('5xx / 429 判为瞬时', () => {
    expect(isTransientAiError(apiError(502, UPSTREAM_502))).toBe(true)
    expect(isTransientAiError(apiError(429, '{}'))).toBe(true)
  })

  it('鉴权/配置类错误判为永久:重试只会重复计费', () => {
    expect(isTransientAiError(apiError(401, '{}'))).toBe(false)
    expect(isTransientAiError(new Error('供应商「x」缺少 Base URL'))).toBe(false)
  })

  it('RetryError 穿透到 lastError 判定', () => {
    const retry = new RetryError({
      message: 'Failed after 3 attempts',
      reason: 'maxRetriesExceeded',
      errors: [apiError(503, '{}')]
    })
    expect(isTransientAiError(retry)).toBe(true)
  })

  it('网络类 Error 按特征词识别', () => {
    expect(isTransientAiError(new Error('fetch failed'))).toBe(true)
    expect(isTransientAiError(new TypeError('terminated'))).toBe(true)
  })
})

/**
 * 真实案例:view_image 的图片结果没经 toModelOutput,被 SDK 包成 json 后消息
 * 非法,用户只看到 "Invalid prompt: The messages do not match the ModelMessage[]
 * schema." ——完全看不出这是本地拼装错误,一路去查网关和 Base URL。
 *
 * 用真的 streamText 造这个错误(而不是手搓一个 InvalidPromptError):要钉住的
 * 正是 SDK 那条 cause 链的实际形状,手搓等于把被测的东西替换成假设。
 */
describe('消息形态非法', () => {
  async function invalidPromptError(): Promise<unknown> {
    const model = {
      specificationVersion: 'v3',
      provider: 'p',
      modelId: 'm',
      supportedUrls: {},
      doStream: async () => {
        throw new Error('不该走到这里:消息校验在发请求之前')
      }
    }
    const result = streamText({
      model: model as never,
      messages: [
        { role: 'user', content: 'hi' },
        {
          role: 'tool',
          content: [
            {
              type: 'tool-result',
              toolCallId: 'c',
              toolName: 'view_image',
              // SDK 在工具没声明 toModelOutput 时就是这样包的:Buffer 进了 json。
              // 这份 output 本来就不是合法 JSONValue——要复现的正是这个,所以
              // 只能断言绕过类型检查,不能改成合法值
              output: {
                type: 'json',
                value: { value: [{ type: 'file', data: { data: Buffer.from([1]) } }] } as never
              }
            }
          ]
        }
      ]
    })
    for await (const part of result.fullStream) if (part.type === 'error') return part.error
    throw new Error('没等到 error 分片')
  }

  it('定性成本地拼装错误,并明说重试无效', async () => {
    const out = errorMessage(await invalidPromptError())
    expect(out).toContain('本地拼装消息的错误')
    expect(out).toContain('重试无效')
  })

  it('从 cause 链里挖出可疑位置,而不是只透传那句 schema 文案', async () => {
    const out = errorMessage(await invalidPromptError())
    expect(out).toContain('可疑位置')
    expect(out).toContain('output')
  })

  it('判为永久错误:重试只会重复计费', async () => {
    expect(isTransientAiError(await invalidPromptError())).toBe(false)
  })
})

describe('其他错误', () => {
  it('中止/超时归一成"请求超时"', () => {
    const err = new Error('aborted')
    err.name = 'AbortError'
    expect(errorMessage(err)).toBe('请求超时')
  })

  it('普通 Error 原样透出', () => {
    expect(errorMessage(new Error('供应商「x」缺少 Base URL'))).toContain('缺少 Base URL')
  })

  it('非 Error 也不能炸', () => {
    expect(errorMessage('炸了')).toBe('炸了')
  })
})
