import { APICallError, RetryError } from 'ai'

/**
 * AI 请求错误的统一解读,所有链路(设计/纯聊天/群组/辅助模型)共用:
 * - errorMessage:翻成用户看得懂、且**能据此行动**的一句话;
 * - isTransientAiError:判定是不是值得原地重试的瞬时故障。
 *
 * 单独成家(而不是塞在 registry 里)是因为它只依赖 'ai' 的错误类型,
 * 群组等调用方引用它时不必被 registry 的密钥/DB 依赖拖下水。
 */

/**
 * 把 SDK 抛出来的错误翻成一句人话。
 *
 * 原来直接return err.message,遇到网关 502 时用户只看到 "Upstream request
 * failed"——既不知道是哪一层挂的,也不知道该不该改配置,只能去猜 Base URL
 * 写错了。这里把状态码和它的含义摆出来,把"该改配置"和"上游抽风、重试即
 * 可"这两类彻底分开。
 */
export function errorMessage(err: unknown): string {
  // 重试耗尽:外层只说"试了 N 次",真正的原因在 lastError 里
  if (RetryError.isInstance(err)) {
    const inner = describe(err.lastError)
    return `重试 ${err.errors.length} 次仍失败:${inner}`
  }
  return describe(err)
}

/** 流中途错误事件的常见形态:可能平铺,也可能再包一层 error */
interface StreamErrorShape {
  type?: string
  code?: string
  message?: string
  error?: unknown
}

function describe(err: unknown): string {
  if (APICallError.isInstance(err)) {
    const status = err.statusCode
    const detail = upstreamMessage(err.responseBody) ?? err.message
    const hint = status ? STATUS_HINTS[status] : undefined
    return hint ? `${hint}(HTTP ${status}:${detail})` : `HTTP ${status ?? '?'}:${detail}`
  }
  if (err instanceof Error) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') return '请求超时'
    return err.message
  }
  // 流中途的错误不是 Error 实例:HTTP 已经 200,中转站把上游故障作为
  // SSE error 事件发回来,SDK 原样透传这个裸对象。把可读字段挖出来,
  // 否则用户只能看到 [object Object]
  if (err && typeof err === 'object') {
    const outer = err as StreamErrorShape
    const inner = (
      outer.error && typeof outer.error === 'object' ? outer.error : outer
    ) as StreamErrorShape
    const detail = inner.message ?? inner.code ?? inner.type
    if (detail) {
      const kind = inner.type && inner.type !== detail ? `${inner.type}:` : ''
      return `上游在响应中途报错(${kind}${detail}),不是本地配置的问题,稍后重试`
    }
  }
  return String(err)
}

/**
 * 是否值得原地重试。两类来源:
 * - HTTP 层失败:SDK 抛 APICallError,看状态码或 SDK 自己标的 isRetryable;
 * - 流中途错误事件:HTTP 已经 200,SDK 的 maxRetries 管不到它,只能按错误
 *   文本里的特征词识别(upstream_error / stream_read / overloaded…)。
 *
 * 判定宁可保守:漏判成"永久"只是让用户手动重发一次,误判成"瞬时"却会对
 * 鉴权/参数类错误重复计费——所以特征词只收录明确的瞬时故障。
 */
export function isTransientAiError(err: unknown): boolean {
  if (RetryError.isInstance(err)) return isTransientAiError(err.lastError)
  if (APICallError.isInstance(err)) {
    return err.isRetryable || TRANSIENT_STATUS.has(err.statusCode ?? 0)
  }
  const text = err instanceof Error ? `${err.name} ${err.message}` : safeStringify(err)
  return TRANSIENT_PATTERN.test(text)
}

const TRANSIENT_STATUS = new Set([408, 429, 500, 502, 503, 504])

const TRANSIENT_PATTERN =
  /upstream_error|stream_read|server_error|overloaded|rate.?limit|timed?.?out|timeout|econnreset|econnrefused|socket hang up|network|fetch failed|terminated|premature/i

/** 错误对象可能带循环引用(响应对象之类),stringify 失败就退回 String */
function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

/**
 * 按状态码分流:哪些是"你的配置有问题",哪些是"服务端的事,重试就好"。
 * 这个区分比错误原文有用得多——它直接决定用户下一步做什么。
 */
const STATUS_HINTS: Record<number, string> = {
  401: 'API Key 无效或已过期,检查供应商配置',
  403: '没有访问这个模型的权限',
  404: '接口或模型不存在,检查 Base URL 是否需要带 /v1、模型名是否拼对',
  413: '请求体太大,减少附件或让对话短一些',
  429: '被限流了,稍等再试',
  500: '服务端内部错误,不是本地配置的问题',
  502: '网关的上游服务挂了,不是本地配置的问题,稍后重试',
  503: '服务暂时不可用,稍后重试',
  504: '上游响应超时,稍后重试'
}

/** 响应体通常是 `{"error":{"message":"..."}}`,把那句话挖出来,别把整段 JSON 甩给用户 */
function upstreamMessage(body: string | undefined): string | undefined {
  if (!body) return undefined
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string }; message?: string }
    return parsed.error?.message ?? parsed.message
  } catch {
    return undefined
  }
}
