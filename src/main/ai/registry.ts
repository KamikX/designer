import { createAnthropic } from '@ai-sdk/anthropic'
import { createDeepSeek } from '@ai-sdk/deepseek'
import { createGoogleGenerativeAI } from '@ai-sdk/google'
import { createOpenAI } from '@ai-sdk/openai'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { APICallError, RetryError, generateText } from 'ai'
import type { LanguageModel } from 'ai'
import type { AdapterType, ProviderTestResult } from '../../shared/types'
import { decryptSecret } from '../crypto'
import { getProviderRowById } from '../db/repo/provider'
import { listModels } from '../db/repo/model'
import { RunTraceCollector } from './run-trace'
import { openaiCompatOptions } from './provider-options'
import type { KeyStorage } from '../crypto'

/**
 * AI SDK 实例工厂。
 *
 * 这是全应用唯一接触 API Key 明文的地方：从 providers 行解出密文、
 * 解密、传给 SDK 工厂,明文的生命周期只有这一个函数调用栈,
 * 不落日志、不进 IPC、不进任何长生命周期对象。
 *
 * 实例按 providerId:updatedAt 缓存——provider 一有改动(换 key、
 * 改 baseUrl)updatedAt 就变,旧实例自动失效,不用手动清缓存。
 */

const cache = new Map<string, (modelId: string) => LanguageModel>()

export function getLanguageModel(providerId: string, modelId: string): LanguageModel {
  const row = getProviderRowById(providerId)
  if (!row) throw new Error('供应商不存在')
  if (!row.enabled) throw new Error(`供应商「${row.name}」已停用`)

  const cacheKey = `${row.id}:${row.updatedAt}`
  let factory = cache.get(cacheKey)
  if (!factory) {
    if (!row.apiKeyCipher) throw new Error(`供应商「${row.name}」未配置 API Key`)
    const apiKey = decryptSecret(row.apiKeyCipher, row.keyStorage as KeyStorage)
    if (apiKey == null) {
      throw new Error(`供应商「${row.name}」的密钥无法解密(可能是换了机器),请重新录入`)
    }

    const baseURL = row.baseUrl ?? undefined
    switch (row.adapter) {
      case 'openai': {
        const p = createOpenAI({ apiKey, baseURL })
        factory = (m) => p(m)
        break
      }
      case 'anthropic': {
        const p = createAnthropic({ apiKey, baseURL })
        factory = (m) => p(m)
        break
      }
      case 'google': {
        const p = createGoogleGenerativeAI({ apiKey, baseURL })
        factory = (m) => p(m)
        break
      }
      case 'deepseek': {
        const p = createDeepSeek({ apiKey, baseURL })
        factory = (m) => p(m)
        break
      }
      default: {
        if (!baseURL) throw new Error(`供应商「${row.name}」缺少 Base URL`)
        const p = createOpenAICompatible({ name: row.slug, apiKey, baseURL })
        factory = (m) => p(m)
      }
    }
    // 只留最新实例。provider 数量个位数,单实例缓存足够,还省了失效清扫
    for (const key of cache.keys()) {
      if (key.startsWith(`${row.id}:`)) cache.delete(key)
    }
    cache.set(cacheKey, factory)
  }
  return factory(modelId)
}

/**
 * 连通性测试:发一条真实的最小请求。比调 list-models 端点通用——
 * anthropic 和各家兼容端点的模型列表接口行为不一,聊天补全是唯一
 * 都保证有的能力。
 */
export async function testProvider(
  providerId: string,
  modelId?: string
): Promise<ProviderTestResult> {
  try {
    const target =
      modelId ?? listModels(providerId).find((m) => m.enabled && m.type === 'chat')?.modelId
    if (!target) return { ok: false, error: '该供应商下没有可用的对话模型' }

    // 连通性测试是真实计费请求,计入长期用量;用量页可按场景排除
    const row = getProviderRowById(providerId)
    const trace = new RunTraceCollector({
      scene: 'provider_test',
      providerId,
      providerSlug: row?.slug ?? '',
      modelId: target,
      adapter: row?.adapter as AdapterType | undefined
    })
    trace.start()

    const start = Date.now()
    try {
      await generateText({
        model: getLanguageModel(providerId, target),
        prompt: 'ping',
        // 连通性测试要和真实请求同参:兼容参数不同的话,"测试通过、一用就炸"
        providerOptions: { openai: openaiCompatOptions() },
        maxOutputTokens: 8,
        onLanguageModelCallStart: ({ callId }) => trace.modelCallStart(callId),
        onLanguageModelCallEnd: (event) =>
          trace.stepEnd(event.callId, event.usage, {
            finishReason: event.finishReason,
            responseTimeMs: event.performance?.responseTimeMs ?? null
          }),
        abortSignal: AbortSignal.timeout(10_000)
      })
      trace.finish('complete')
    } catch (err) {
      trace.finish('error')
      throw err
    }
    return { ok: true, latencyMs: Date.now() - start }
  } catch (err) {
    return { ok: false, error: errorMessage(err) }
  }
}

/** 把 SDK 的各式异常压成一句人能读的话,渲染层直接展示 */
/**
 * 把 SDK 抛出来的错误翻成用户看得懂、且**能据此行动**的一句话。
 *
 * 原来直接returnerr.message,遇到网关 502 时用户只看到 "Upstream request
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
  return String(err)
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
