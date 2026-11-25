import { text as appText } from '../../i18n'
import type { StorageBackend } from '../types'

export interface S3Options {
  endpoint: string
  region: string
  bucket: string
  accessKey: string
  secretKey: string
  publicBaseUrl: string
  forcePathStyle: boolean
}

/**
 * S3 兼容后端(MinIO / R2 / OSS / COS…)。
 *
 * @aws-sdk/client-s3 动态 import:mode=local 的用户永远不加载这几 MB,
 * 冷启动零开销。
 */
export async function createS3Backend(opts: S3Options): Promise<StorageBackend> {
  const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } =
    await import('@aws-sdk/client-s3')

  const client = new S3Client({
    endpoint: opts.endpoint,
    region: opts.region || 'auto',
    credentials: { accessKeyId: opts.accessKey, secretAccessKey: opts.secretKey },
    // MinIO 等自建服务基本都要求 path-style,默认开
    forcePathStyle: opts.forcePathStyle
  })

  const put = async (key: string, data: Buffer, mime: string): Promise<void> => {
    await client.send(
      new PutObjectCommand({ Bucket: opts.bucket, Key: key, Body: data, ContentType: mime })
    )
  }
  const get = async (key: string): Promise<Buffer> => {
    const res = await client.send(new GetObjectCommand({ Bucket: opts.bucket, Key: key }))
    const bytes = await res.Body!.transformToByteArray()
    return Buffer.from(bytes)
  }
  const del = async (key: string): Promise<void> => {
    await client.send(new DeleteObjectCommand({ Bucket: opts.bucket, Key: key }))
  }

  return {
    put,
    get,
    delete: del,
    publicUrl(key) {
      if (!opts.publicBaseUrl) return null
      return `${opts.publicBaseUrl.replace(/\/$/, '')}/${key}`
    },
    async test() {
      // 实际写读删一个测试对象,比 HeadBucket 可靠——各家兼容实现的
      // 权限模型对 Head 的态度不一,能写读才是真可用
      const key = `.antd-designer-test-${Date.now()}`
      const payload = Buffer.from('ok')
      await put(key, payload, 'text/plain')
      const back = await get(key)
      await del(key)
      if (!back.equals(payload))
        throw new Error(appText('messages.writtenContentDiffersFromTheContentReadBack'))
    }
  }
}
