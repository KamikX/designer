import { asc, eq, sql } from 'drizzle-orm'
import { ulid } from 'ulid'
import type { AdapterType, CreateProviderInput, Provider } from '../../../shared/types'
import { encryptSecret, maskKey } from '../../crypto'
import { getDb } from '../index'
import { providers } from '../schema'
import type { ProviderRow } from '../schema'

/**
 * 供应商仓储。
 *
 * 安全边界在类型上钉死：对外的 Provider（shared 类型）根本没有密文
 * 字段，toView 是唯一的行→契约转换点，想漏都编译不过。密文只有
 * getProviderRowById 能拿到，且只允许主进程 ai/registry 消费。
 */

function toView(row: ProviderRow): Provider {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    adapter: row.adapter as AdapterType,
    baseUrl: row.baseUrl,
    hasKey: row.apiKeyCipher != null,
    keyStorage: row.keyStorage as 'safe' | 'plain',
    keyHint: row.keyHint,
    enabled: row.enabled,
    isBuiltin: row.isBuiltin,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  }
}

const touch = { updatedAt: sql`(datetime('now'))` }

export function listProviders(): Provider[] {
  return getDb().select().from(providers).orderBy(asc(providers.createdAt)).all().map(toView)
}

/** 仅主进程内部使用（ai/registry 解密组装 SDK 实例），严禁进任何 IPC 返回值 */
export function getProviderRowById(id: string): ProviderRow | null {
  return getDb().select().from(providers).where(eq(providers.id, id)).get() ?? null
}

export function setProviderKey(id: string, apiKey: string): Provider {
  const { cipher, storage } = encryptSecret(apiKey)
  return toView(
    getDb()
      .update(providers)
      .set({ apiKeyCipher: cipher, keyStorage: storage, keyHint: maskKey(apiKey), ...touch })
      .where(eq(providers.id, id))
      .returning()
      .get()
  )
}

export function clearProviderKey(id: string): Provider {
  return toView(
    getDb()
      .update(providers)
      .set({ apiKeyCipher: null, keyHint: null, ...touch })
      .where(eq(providers.id, id))
      .returning()
      .get()
  )
}

export function updateProvider(
  id: string,
  patch: Partial<Pick<Provider, 'name' | 'baseUrl' | 'enabled'>>
): Provider | null {
  const updated = getDb()
    .update(providers)
    .set({ ...patch, ...touch })
    .where(eq(providers.id, id))
    .returning()
    .get()
  return updated ? toView(updated) : null
}

export function createProvider(input: CreateProviderInput): Provider {
  const key = input.apiKey ? encryptSecret(input.apiKey) : null
  return toView(
    getDb()
      .insert(providers)
      .values({
        slug: `custom-${ulid().toLowerCase()}`,
        name: input.name,
        // 用户新增时自选适配类型:官方各家或任意 OpenAI 兼容端点(中转站/本地推理)
        adapter: input.adapter,
        baseUrl: input.baseUrl ?? null,
        apiKeyCipher: key?.cipher ?? null,
        keyStorage: key?.storage ?? 'safe',
        keyHint: input.apiKey ? maskKey(input.apiKey) : null,
        isBuiltin: false
      })
      .returning()
      .get()
  )
}

export function deleteProvider(id: string): void {
  getDb().delete(providers).where(eq(providers.id, id)).run()
}

/**
 * 一次性清理:早期版本会把内置预设种到 providers 表里,现在的产品
 * 形态是"列表默认为空,预设只存在于添加向导里"。启动时把从未配置过
 * 密钥的遗留内置行删掉(级联删其模型);已配了密钥的保留——那是用户
 * 真实在用的配置。
 */
export function cleanupSeededProviders(): void {
  getDb()
    .delete(providers)
    .where(sql`${providers.isBuiltin} = 1 AND ${providers.apiKeyCipher} IS NULL`)
    .run()
}
