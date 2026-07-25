import { createHash } from 'crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname, extname, join } from 'path'
import { ulid } from 'ulid'
import type { AssetRef, ProviderTestResult, StorageConfigInput } from '../../shared/types'
import { createAssetRecord, findAssetBySha256, getAssetRecord } from '../db/repo/asset'
import { ASSET_CACHE_DIR } from '../paths'
import { s3Credentials, storageMode } from '../services-config'
import { createLocalBackend } from './backends/local'
import { createS3Backend } from './backends/s3'
import { prepareImage } from './image'
import type { StorageBackend } from './types'

/**
 * 资源服务:asset://<id> 是渲染进程唯一可见的引用形态。
 *
 * 写入时按当前配置落 local 或 s3;读取时按行内记录的 backend 解析,
 * 与"当前配置"无关——切换配置不影响已存资源。s3 资源读取时落本地
 * 缓存,断网也能显示看过的图。
 */

const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf'
}

async function activeBackend(): Promise<{ backend: StorageBackend; kind: 'local' | 's3' }> {
  if (storageMode() === 's3') {
    const creds = s3Credentials()
    if (creds) return { backend: await createS3Backend(creds), kind: 's3' }
    // S3 配置不完整时静默退回本地,导入不该因此失败
  }
  return { backend: createLocalBackend(), kind: 'local' }
}

export async function importAsset(filePath: string): Promise<AssetRef> {
  const data = readFileSync(filePath)
  const id = ulid()
  const mime = MIME_BY_EXT[extname(filePath).toLowerCase()] ?? 'application/octet-stream'
  const { backend, kind } = await activeBackend()

  // local:两级目录防单目录文件过多;s3:统一 assets/ 前缀
  const key = kind === 'local' ? `${id.slice(0, 2)}/${id}` : `assets/${id}`
  await backend.put(key, data, mime)

  createAssetRecord({
    id,
    mime,
    size: data.length,
    sha256: createHash('sha256').update(data).digest('hex'),
    backend: kind,
    location: key
  })
  return { id, uri: `asset://${id}`, mime, size: data.length }
}

/**
 * 导入图片字节(拖拽 / 粘贴 / 选文件通用)。
 *
 * 入库前先缩放——省的是后面每一次发送的上行带宽和被拒风险,见 image.ts。
 * 按 sha256 去重:同一张图拖两次不该变成两条记录、两份存储。
 */
export async function importImage(input: {
  name: string
  mime: string
  data: Buffer
}): Promise<AssetRef> {
  const prepared = prepareImage(input.data, input.mime, input.name)
  const sha256 = createHash('sha256').update(prepared.data).digest('hex')

  const existing = findAssetBySha256(sha256)
  if (existing) {
    return {
      id: existing.id,
      uri: `asset://${existing.id}`,
      mime: existing.mime,
      size: existing.size,
      width: prepared.width || undefined,
      height: prepared.height || undefined
    }
  }

  const id = ulid()
  const { backend, kind } = await activeBackend()
  const key = kind === 'local' ? `${id.slice(0, 2)}/${id}` : `assets/${id}`
  await backend.put(key, prepared.data, prepared.mime)

  createAssetRecord({
    id,
    mime: prepared.mime,
    size: prepared.data.length,
    sha256,
    backend: kind,
    location: key
  })
  return {
    id,
    uri: `asset://${id}`,
    mime: prepared.mime,
    size: prepared.data.length,
    width: prepared.width || undefined,
    height: prepared.height || undefined
  }
}

/** asset:// 协议用:按 id 取回实体与 mime */
export async function resolveAsset(id: string): Promise<{ data: Buffer; mime: string } | null> {
  const row = getAssetRecord(id)
  if (!row) return null

  if (row.backend === 'local') {
    const backend = createLocalBackend()
    return { data: await backend.get(row.location), mime: row.mime }
  }

  const cachePath = join(ASSET_CACHE_DIR, id)
  if (existsSync(cachePath)) {
    return { data: readFileSync(cachePath), mime: row.mime }
  }
  const creds = s3Credentials()
  if (!creds) return null
  const backend = await createS3Backend(creds)
  const data = await backend.get(row.location)
  mkdirSync(dirname(cachePath), { recursive: true })
  writeFileSync(cachePath, data)
  return { data, mime: row.mime }
}

/** 连通性测试:用传入参数(未传 secretKey 时借用已存密文)实测写读删 */
export async function testStorage(input: StorageConfigInput): Promise<ProviderTestResult> {
  try {
    if (input.mode === 'local' || !input.s3) return { ok: true }
    const secretKey = input.s3.secretKey ?? s3Credentials()?.secretKey
    if (!secretKey) return { ok: false, error: '缺少 Secret Key' }
    const start = Date.now()
    const backend = await createS3Backend({
      endpoint: input.s3.endpoint,
      region: input.s3.region ?? 'auto',
      bucket: input.s3.bucket,
      accessKey: input.s3.accessKey,
      secretKey,
      publicBaseUrl: input.s3.publicBaseUrl ?? '',
      forcePathStyle: input.s3.forcePathStyle ?? true
    })
    await backend.test()
    return { ok: true, latencyMs: Date.now() - start }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}
