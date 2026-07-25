/**
 * 对象存储后端抽象。
 *
 * "用户自配 S3"和"本地目录"是它的两个实现;未来官方 SaaS 的
 * CloudStorageBackend(走官方上传凭证接口)也实现这个接口——
 * service / asset:// 协议 / UI 全部无感复用。
 */
export interface StorageBackend {
  put: (key: string, data: Buffer, mime: string) => Promise<void>
  get: (key: string) => Promise<Buffer>
  delete: (key: string) => Promise<void>
  /** 可公网访问的 URL(配置了 publicBaseUrl 时);无则 null */
  publicUrl: (key: string) => string | null
  test: () => Promise<void>
}
