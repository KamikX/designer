import { text as appText } from '../../i18n'
import type { StorageBackend } from '../types'

/**
 * 官方云服务的对象存储后端 —— 占位,未实现。
 *
 * 落地时的要点(给未来的实现者):
 * - put/get 走官方 API 的上传/下载凭证接口(预签名 URL),鉴权用账号 token;
 * - 需要考虑配额与失败重试;
 * - 账号切换时本地缓存要按 accountId 隔离(参见 sync/backends/cloud.ts 同样的约束);
 * - 实现完成后在 storage/service.ts 的 activeBackend() 里按
 *   dataBackend.mode === 'cloud' 分派即可,其余代码零改动。
 */
export function createCloudBackend(): StorageBackend {
  throw new Error(appText('messages.officialCloudStorageIsNotAvailableYet'))
}
