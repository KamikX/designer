import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { ulid } from 'ulid'
import { DB_FILE, ensureDataDirs } from '../paths'
import { MIGRATIONS } from './migrations'
import * as schema from './schema'

let sqlite: Database.Database | null = null
let db: BetterSQLite3Database<typeof schema> | null = null

export function getDb(): BetterSQLite3Database<typeof schema> {
  if (db) return db

  ensureDataDirs()
  sqlite = new Database(DB_FILE)

  // WAL：读不阻塞写，桌面端多窗口/后台任务同时读时体验差别很大
  sqlite.pragma('journal_mode = WAL')
  // 外键约束默认是关的，必须每个连接显式打开
  sqlite.pragma('foreign_keys = ON')

  migrate(sqlite)
  ensureSyncBase(sqlite)

  db = drizzle(sqlite, { schema })
  return db
}

/**
 * 参与同步的业务表。change_log/local_meta 是同步设施自身，不在其列。
 *
 * workspace_roots 也**故意不同步**：它存的是本机的绝对路径，同步到另一台
 * 机器上要么路径不存在，要么更糟——恰好存在一个同名目录，于是把那台机器上
 * 完全不相干的目录授权给了 AI。授权必须在哪台机器上给、就只在哪台机器上生效。
 */
const SYNCED_TABLES = [
  'projects',
  'providers',
  'models',
  'conversations',
  'messages',
  'artifacts',
  'artifact_files',
  'assets',
  'mcp_servers',
  'skills'
] as const

/**
 * 同步地基：device_id 与 change_log 触发器。
 *
 * 触发器不进迁移文件而是每次启动时删旧建新——触发器定义会随同步逻辑
 * 演进，而"已发布迁移不可改"；DROP + CREATE 幂等且开销可忽略，
 * 定义只在这一处维护。
 *
 * sync_applying 标志：将来 pull 应用远端数据时置 '1'，触发器的 WHEN
 * 会跳过记录，避免拉下来的行再被记进 change_log 推回去，造成回环。
 */
function ensureSyncBase(conn: Database.Database): void {
  conn.prepare(`INSERT OR IGNORE INTO local_meta (k, v) VALUES ('device_id', ?)`).run(ulid())
  conn.prepare(`INSERT OR IGNORE INTO local_meta (k, v) VALUES ('sync_applying', '0')`).run()

  const guard = `COALESCE((SELECT v FROM local_meta WHERE k='sync_applying'),'0') <> '1'`
  for (const tbl of SYNCED_TABLES) {
    for (const [suffix, event, rowRef, op] of [
      ['ai', 'INSERT', 'NEW', 'upsert'],
      ['au', 'UPDATE', 'NEW', 'upsert'],
      ['ad', 'DELETE', 'OLD', 'delete']
    ] as const) {
      conn.exec(`DROP TRIGGER IF EXISTS trg_sync_${tbl}_${suffix}`)
      conn.exec(
        `CREATE TRIGGER trg_sync_${tbl}_${suffix} AFTER ${event} ON ${tbl}
         WHEN ${guard}
         BEGIN
           INSERT INTO change_log (tbl, row_id, op) VALUES ('${tbl}', ${rowRef}.id, '${op}');
         END`
      )
    }
  }
}

/**
 * 用 SQLite 自带的 user_version 记录进度，不用 drizzle 的运行时 migrator
 * ——后者要读磁盘上的 migrations 目录，打包进 Electron 后路径很难伺候。
 */
function migrate(conn: Database.Database): void {
  const current = conn.pragma('user_version', { simple: true }) as number
  if (current >= MIGRATIONS.length) return

  /*
   * 外键**必须在事务外关掉**。
   *
   * SQLite 改列(改可空、加约束)只能靠"建新表 → 拷数据 → 删旧表 → 改名",
   * drizzle 生成的 SQL 里也带着 `PRAGMA foreign_keys=OFF`。但那句话写在
   * 迁移文件里就等于写在事务里,而 **PRAGMA foreign_keys 在事务内是静默
   * no-op** ——不报错,值也不变。
   *
   * 后果不是"迁移失败",是**静默删数据**:外键还开着的时候 DROP TABLE 会
   * 执行一次隐式 DELETE FROM,于是 messages 上那条 ON DELETE CASCADE 生效,
   * 删 conversations 表把所有消息一起带走了。实测复现过:2 行 → 0 行。
   *
   * 所以在这里、事务之外关掉,跑完再打开。
   */
  conn.pragma('foreign_keys = OFF')
  try {
    for (let version = current; version < MIGRATIONS.length; version++) {
      // SQLite 的 DDL 支持事务，迁移到一半崩了不会留下半张表
      conn.transaction(() => {
        conn.exec(MIGRATIONS[version])
        conn.pragma(`user_version = ${version + 1}`)
      })()
    }
  } finally {
    conn.pragma('foreign_keys = ON')
  }

  // 关着外键跑完之后校一遍:重建表时漏拷一列、写错一个引用,都会在这里露出来。
  // 只报不改——自动"修复"很可能是继续删数据
  const dangling = conn.pragma('foreign_key_check') as unknown[]
  if (dangling.length) {
    console.error(`[db] 迁移后发现 ${dangling.length} 条悬空外键引用:`, dangling.slice(0, 5))
  }
}

export function closeDb(): void {
  sqlite?.close()
  sqlite = null
  db = null
}
