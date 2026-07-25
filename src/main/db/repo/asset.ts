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
