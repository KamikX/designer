import { createAnthropic } from '@ai-sdk/anthropic'
import { createDeepSeek } from '@ai-sdk/deepseek'
import { createGoogleGenerativeAI } from '@ai-sdk/google'
import { createOpenAI } from '@ai-sdk/openai'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { generateText } from 'ai'
import type { LanguageModel } from 'ai'
import type { ProviderTestResult } from '../../shared/types'
import { decryptSecret } from '../crypto'
import { getProviderRowById } from '../db/repo/provider'
import { listModels } from '../db/repo/model'
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

    const start = Date.now()
    await generateText({
      model: getLanguageModel(providerId, target),
      prompt: 'ping',
      maxOutputTokens: 8,
      abortSignal: AbortSignal.timeout(10_000)
    })
    return { ok: true, latencyMs: Date.now() - start }
  } catch (err) {
    return { ok: false, error: errorMessage(err) }
  }
}

/** 把 SDK 的各式异常压成一句人能读的话,渲染层直接展示 */
export function errorMessage(err: unknown): string {
  if (err instanceof Error) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') return '请求超时'
    return err.message
  }
  return String(err)
}
