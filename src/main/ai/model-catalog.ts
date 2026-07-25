import type { FetchModelsInput, RemoteModel } from '../../shared/types'
import { decryptSecret } from '../crypto'
import type { KeyStorage } from '../crypto'
import { getProviderRowById } from '../db/repo/provider'

/**
 * 拉取供应商的可用模型列表(配置向导里的"加载模型"按钮)。
 *
 * 各家的 list-models 端点格式不一,这里按 adapter 分派;返回的只是
 * 候选清单,用户勾选后才经 model:set-selection 入库。
 */

const DEFAULT_BASE: Record<string, string> = {
  openai: 'https://api.openai.com/v1',
  deepseek: 'https://api.deepseek.com',
  anthropic: 'https://api.anthropic.com',
  google: 'https://generativelanguage.googleapis.com/v1beta'
}

export async function fetchRemoteModels(input: FetchModelsInput): Promise<RemoteModel[]> {
  let { baseUrl, apiKey } = input

  // 已保存的供应商可以不重复传参:key 在主进程内部解密,绝不出 IPC
  if (input.providerId) {
    const row = getProviderRowById(input.providerId)
    if (row) {
      baseUrl = baseUrl ?? row.baseUrl
      if (!apiKey && row.apiKeyCipher) {
        apiKey = decryptSecret(row.apiKeyCipher, row.keyStorage as KeyStorage) ?? undefined
      }
    }
  }
  if (!apiKey) throw new Error('请先填写 API Key')

  const base = (baseUrl || DEFAULT_BASE[input.adapter] || '').replace(/\/$/, '')
  if (!base) throw new Error('缺少 Base URL')

  const signal = AbortSignal.timeout(15_000)

  try {
    if (input.adapter === 'anthropic') {
      const res = await fetch(`${base}/v1/models?limit=100`, {
        headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        signal
      })
      await ensureOk(res)
      const json = (await res.json()) as { data?: { id: string; display_name?: string }[] }
      return (json.data ?? []).map((m) => ({ modelId: m.id, displayName: m.display_name || m.id }))
    }

    if (input.adapter === 'google') {
      const res = await fetch(`${base}/models?pageSize=200&key=${encodeURIComponent(apiKey)}`, {
        signal
      })
      await ensureOk(res)
      const json = (await res.json()) as { models?: { name: string; displayName?: string }[] }
      return (json.models ?? []).map((m) => {
        const id = m.name.replace(/^models\//, '')
        return { modelId: id, displayName: m.displayName || id }
      })
    }

    // openai / deepseek / openai-compatible(含智谱)都是 OpenAI 形状的 /models
    const res = await fetch(`${base}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal
    })
    await ensureOk(res)
    const json = (await res.json()) as { data?: { id: string }[] }
    return (json.data ?? []).map((m) => ({ modelId: m.id, displayName: m.id }))
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      throw new Error('请求超时,请检查 Base URL 与网络')
    }
    throw err
  }
}

async function ensureOk(res: Response): Promise<void> {
  if (res.ok) return
  let detail = ''
  try {
    detail = (await res.text()).slice(0, 200)
  } catch {
    /* 忽略读 body 失败 */
  }
  throw new Error(`HTTP ${res.status}${detail ? `: ${detail}` : ''}`)
}
