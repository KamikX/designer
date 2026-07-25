import { eq } from 'drizzle-orm'
import { getDb } from '../index'
import { assets } from '../schema'
import type { AssetRow } from '../schema'

/** 资源索引仓储。实体在本地目录或 S3,库里只有元数据与位置。 */

export function createAssetRecord(input: {
  id: string
  mime: string
  size: number
  sha256: string
  backend: 'local' | 's3'
  location: string
}): AssetRow {
  return getDb().insert(assets).values(input).returning().get()
}

export function getAssetRecord(id: string): AssetRow | null {
  return getDb().select().from(assets).where(eq(assets.id, id)).get() ?? null
}

/**
 * 按内容哈希查已有资源。
 *
 * 同一张图被拖进来两次不该变成两条记录、两份存储——sha256 本来就在算,
 * 只是之前没用它去重。
 */
export function findAssetBySha256(sha256: string): AssetRow | null {
  return getDb().select().from(assets).where(eq(assets.sha256, sha256)).get() ?? null
}
