/**
 * 数据同步后端抽象(本期只定义接口,引擎二期实现)。
 *
 * 架构:SQLite 永远是唯一读写主库,同步引擎按 change_log 增量 push、
 * 按远端 server_seq 游标 pull,行级 LWW(updated_at 字典序,平局比
 * device_id)。远端只有两张方言无关的表:
 *
 *   sync_rows(tbl, row_id, payload JSON, updated_at, deleted, device_id, server_seq)
 *   sync_meta(k, v)
 *
 * "用户自配 MySQL/PG"(backends/self-hosted.ts,二期)和"官方云服务"
 * (backends/cloud.ts,三期)都是本接口的实现,引擎与 UI 全部复用。
 */

export interface SyncRow {
  tbl: string
  rowId: string
  /** 整行 JSON 快照。providers/models 序列化时白名单剔除密钥密文列 */
  payload: unknown
  updatedAt: string
  deleted: boolean
  deviceId: string
}

export interface SyncBackend {
  test: () => Promise<void>
  /** self-hosted:建 sync_rows/sync_meta;cloud:no-op */
  ensureSchema: () => Promise<void>
  /** 幂等。实现内部用条件 upsert 完成 LWW */
  push: (batch: SyncRow[]) => Promise<void>
  pull: (
    cursor: string | null,
    limit: number
  ) => Promise<{ rows: SyncRow[]; nextCursor: string | null }>
  close: () => Promise<void>
}

export interface SyncStatus {
  state: 'disabled' | 'idle' | 'syncing' | 'error'
  lastSyncAt: string | null
  /** change_log 中未推送的条数 */
  pendingCount: number
  error?: string
}
