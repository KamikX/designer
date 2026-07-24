import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
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

  db = drizzle(sqlite, { schema })
  return db
}

/**
 * 用 SQLite 自带的 user_version 记录进度，不用 drizzle 的运行时 migrator
 * ——后者要读磁盘上的 migrations 目录，打包进 Electron 后路径很难伺候。
 */
function migrate(conn: Database.Database): void {
  const current = conn.pragma('user_version', { simple: true }) as number

  for (let version = current; version < MIGRATIONS.length; version++) {
    // SQLite 的 DDL 支持事务，迁移到一半崩了不会留下半张表
    conn.transaction(() => {
      conn.exec(MIGRATIONS[version])
      conn.pragma(`user_version = ${version + 1}`)
    })()
  }
}

export function closeDb(): void {
  sqlite?.close()
  sqlite = null
  db = null
}
