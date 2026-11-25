import { text as appText } from '../../i18n'
import type { SyncBackend } from '../types'

/**
 * 官方云服务的同步后端 —— 占位,未实现。
 *
 * 落地时的要点(给未来的实现者):
 * - push/pull 打官方 HTTP API,鉴权头带账号 token;游标即服务端 seq;
 * - 需要考虑配额限流与批次大小协商;
 * - 账号切换时本地库要按 accountId 分库隔离(不同账号的数据绝不能
 *   合进同一个 designer.db);
 * - providers 密钥可考虑口令派生密钥的端到端加密同步(safeStorage
 *   密文是机器绑定的,不能直接上云)。
 */
export function createCloudSyncBackend(): SyncBackend {
  throw new Error(appText('messages.officialCloudSyncIsNotAvailableYet'))
}
