import { text as appText } from '../i18n'
import { APICallError, InvalidPromptError, RetryError } from 'ai'

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
    return appText('messages.stillFailedAfterRetries', err.errors.length, inner)
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
  // 消息形态非法:message 只说"不符合 ModelMessage schema",位置全在 cause 里
  if (InvalidPromptError.isInstance(err)) return describeInvalidPrompt(err)
  if (err instanceof Error) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError')
      return appText('common.requestTimedOut')
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
      return appText('messages.theUpstreamServiceFailedDuringThe', kind, detail)
    }
  }
  return String(err)
}

/**
 * InvalidPromptError:发出去的消息本身形态非法。
 *
 * 这类错误的定性很重要——它**不是网关、不是配置、不是上游抽风,重试也没用**,
 * 是我们自己拼错了消息。原来只透传 `err.message`("...do not match the
 * ModelMessage[] schema."),用户只能猜 Base URL 写错了。
 *
 * 真正的位置在 cause 链里:InvalidPromptError → TypeValidationError → ZodError。
 * 但那是个几十 KB 的嵌套 union(每条消息都要和 system/user/assistant/tool 四种
 * 形态各比一遍),整份贴出来等于没说。所以只挑**路径最深**的几条:union 里越深
 * 的分支就是越接近"本来想匹配的那一种",那才是线索。
 */
function describeInvalidPrompt(err: Error): string {
  const zod = (err.cause as { cause?: { issues?: ZodIssueLike[] } } | undefined)?.cause
  const leaves = Array.isArray(zod?.issues) ? collectLeaves(zod.issues) : []
  const deepest = Math.max(0, ...leaves.map((path) => path.length))
  const clues = [
    ...new Set(leaves.filter((path) => path.length === deepest).map((path) => path.join('.')))
  ]
  const tail = clues.length
    ? appText('messages.possibleLocation', clues.slice(0, 3).join('、'))
    : ''
  return appText('messages.invalidRequestMessageFormatThisIs', err.message, tail)
}

interface ZodIssueLike {
  path?: (string | number)[]
  message?: string
  /** union 的每个候选分支各自一组 issue,path 是相对本层的 */
  errors?: ZodIssueLike[][]
}

/** 把嵌套 union 摊平成叶子,顺路把各层相对 path 拼成完整路径 */
function collectLeaves(
  issues: ZodIssueLike[],
  prefix: (string | number)[] = [],
  out: (string | number)[][] = []
): (string | number)[][] {
  for (const issue of issues) {
    const path = [...prefix, ...(issue.path ?? [])]
    if (issue.errors) {
      for (const branch of issue.errors) collectLeaves(branch, path, out)
    } else if (path.length > 0) {
      out.push(path)
    }
  }
  return out
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
  get 401() {
    return appText('messages.theApiKeyIsInvalidOrExpiredCheckProviderSettings')
  },
  get 403() {
    return appText('messages.youDoNotHaveAccessToThisModel')
  },
  get 404() {
    return appText('messages.endpointOrModelNotFoundCheck')
  },
  get 413() {
    return appText('messages.requestTooLargeReduceAttachmentsOrShortenTheConversation')
  },
  get 429() {
    return appText('messages.rateLimitedWaitAndTryAgain')
  },
  get 500() {
    return appText('messages.internalServerErrorThisIsNotALocalConfigurationIssue')
  },
  get 502() {
    return appText('messages.theGatewaySUpstreamServiceFailed')
  },
  get 503() {
    return appText('messages.serviceTemporarilyUnavailableRetryLater')
  },
  get 504() {
    return appText('messages.upstreamResponseTimedOutRetryLater')
  }
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
