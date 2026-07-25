import { APICallError, RetryError } from 'ai'
import { describe, expect, it } from 'vitest'
import { errorMessage } from './registry'

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
