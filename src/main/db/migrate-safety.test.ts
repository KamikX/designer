import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { MIGRATIONS } from './migrations'

const STYLE_BRIEF_MIGRATION_INDEX = 12

/**
 * 迁移的两条安全底线。
 *
 * 起因是 0006 那次:SQLite 改列只能"建新表 → 拷数据 → 删旧表 → 改名",
 * 而这个动作在外键还开着的时候会**静默删数据**——DROP TABLE 会执行一次隐式
 * DELETE FROM,于是子表上的 ON DELETE CASCADE 生效,删 conversations 把所有
 * messages 一起带走。
 *
 * 更阴的是 drizzle 生成的 SQL 里明明写了 `PRAGMA foreign_keys=OFF`,但那句话
 * 在事务内是**静默 no-op**:不报错,值也不变。所以肉眼看 SQL 是"已经关了"。
 *
 * 这两条测试就是钉住这件事:全套迁移跑完之后,数据必须还在。
 */

/** 复刻 db/index.ts 里的执行器。改那边就要同步改这里,否则测的不是真东西 */
function runMigrations(conn: Database.Database): void {
  conn.pragma('foreign_keys = OFF')
  try {
    for (let version = 0; version < MIGRATIONS.length; version++) {
      conn.transaction(() => {
        conn.exec(MIGRATIONS[version])
        conn.pragma(`user_version = ${version + 1}`)
      })()
    }
  } finally {
    conn.pragma('foreign_keys = ON')
  }
}

describe('PRAGMA foreign_keys 在事务内是 no-op', () => {
  it('事务里关不掉——这就是当初踩的坑', () => {
    const db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    db.transaction(() => {
      db.exec('PRAGMA foreign_keys=OFF;')
      // 值纹丝不动。写在迁移文件里的那句 PRAGMA 因此毫无作用
      expect(db.pragma('foreign_keys', { simple: true })).toBe(1)
    })()
    db.close()
  })

  it('事务外能关掉', () => {
    const db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    db.pragma('foreign_keys = OFF')
    expect(db.pragma('foreign_keys', { simple: true })).toBe(0)
    db.close()
  })

  it('外键开着时 DROP TABLE 会级联删子表——数据就是这么没的', () => {
    const db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    db.exec(`
      CREATE TABLE parent(id TEXT PRIMARY KEY);
      CREATE TABLE child(id TEXT PRIMARY KEY, pid TEXT REFERENCES parent(id) ON DELETE CASCADE);
      INSERT INTO parent VALUES ('p1');
      INSERT INTO child VALUES ('c1','p1'), ('c2','p1');
    `)
    db.exec('DROP TABLE parent;')
    expect(db.prepare('SELECT count(*) n FROM child').get()).toEqual({ n: 0 })
    db.close()
  })
})

describe('全套迁移', () => {
  it('从零跑到最新不报错', () => {
    const db = new Database(':memory:')
    expect(() => runMigrations(db)).not.toThrow()
    expect(db.pragma('user_version', { simple: true })).toBe(MIGRATIONS.length)
    db.close()
  })

  it('跑完之后没有悬空外键', () => {
    const db = new Database(':memory:')
    runMigrations(db)
    expect(db.pragma('foreign_key_check')).toEqual([])
    db.close()
  })

  it('0013 之后五张观测表存在,且不含任何正文类列', () => {
    const db = new Database(':memory:')
    runMigrations(db)
    const tables = (
      db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as { name: string }[]
    ).map((r) => r.name)
    for (const t of [
      'ai_runs',
      'ai_run_steps',
      'tool_runs',
      'model_usage_daily',
      'model_usage_run_days'
    ]) {
      expect(tables).toContain(t)
      // 隐私底线:观测表不许有 prompt / 正文 / 补丁类列
      const cols = (db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map(
        (c) => c.name
      )
      expect(cols).not.toContain('prompt')
      expect(cols).not.toContain('content')
      expect(cols).not.toContain('patch')
      expect(cols.some((c) => c === 'reasoning')).toBe(false)
    }
    db.close()
  })

  it('旧项目经过 0012 后的视觉方向默认为空字符串', () => {
    const db = new Database(':memory:')

    db.pragma('foreign_keys = OFF')
    for (let version = 0; version < STYLE_BRIEF_MIGRATION_INDEX; version++) {
      db.transaction(() => {
        db.exec(MIGRATIONS[version])
        db.pragma(`user_version = ${version + 1}`)
      })()
    }
    db.pragma('foreign_keys = ON')

    db.prepare(`INSERT INTO projects (id, name) VALUES ('legacy-project', '旧项目')`).run()
    db.transaction(() => {
      db.exec(MIGRATIONS[STYLE_BRIEF_MIGRATION_INDEX])
      db.pragma(`user_version = ${STYLE_BRIEF_MIGRATION_INDEX + 1}`)
    })()

    expect(
      db.prepare(`SELECT style_brief FROM projects WHERE id = 'legacy-project'`).get()
    ).toEqual({ style_brief: '' })

    db.close()
  })

  /**
   * 最重要的一条:带着数据跑一遍,看还在不在。
   *
   * 只测"迁移不报错"是不够的——0006 的致命问题恰恰是**不报错地**把数据删了。
   */
  it('已有数据在重建表之后必须还在', () => {
    const db = new Database(':memory:')

    // 先跑到 0006 之前,灌数据,再把剩下的跑完
    db.pragma('foreign_keys = OFF')
    for (let v = 0; v < 6; v++) {
      db.transaction(() => {
        db.exec(MIGRATIONS[v])
        db.pragma(`user_version = ${v + 1}`)
      })()
    }
    db.pragma('foreign_keys = ON')

    db.exec(`
      INSERT INTO projects (id, name) VALUES ('p1', '测试项目');
      INSERT INTO conversations (id, project_id, kind) VALUES ('c1', 'p1', 'design');
      INSERT INTO messages (id, conversation_id, role) VALUES ('m1', 'c1', 'user');
      INSERT INTO messages (id, conversation_id, role) VALUES ('m2', 'c1', 'assistant');
      INSERT INTO workspace_roots (id, project_id, path, name) VALUES ('w1', 'p1', '/tmp/x', 'x');
    `)

    // 0006 会把 conversations 和 workspace_roots 两张表整个重建
    db.pragma('foreign_keys = OFF')
    for (let v = 6; v < MIGRATIONS.length; v++) {
      db.transaction(() => {
        db.exec(MIGRATIONS[v])
        db.pragma(`user_version = ${v + 1}`)
      })()
    }
    db.pragma('foreign_keys = ON')

    // 这两条是真正的底线:消息和授权目录一条都不能少
    expect(db.prepare('SELECT count(*) n FROM messages').get()).toEqual({ n: 2 })
    expect(db.prepare('SELECT count(*) n FROM workspace_roots').get()).toEqual({ n: 1 })
    expect(db.prepare('SELECT count(*) n FROM conversations').get()).toEqual({ n: 1 })

    // 新列存在且对老数据为 NULL
    const root = db.prepare('SELECT conversation_id FROM workspace_roots WHERE id = ?').get('w1')
    expect(root).toEqual({ conversation_id: null })

    db.close()
  })
})

describe('external library migration', () => {
  it('preserves existing projects with no external dependencies', () => {
    const db = new Database(':memory:')
    try {
      for (const migration of MIGRATIONS.slice(0, 15)) db.exec(migration)
      db.prepare('INSERT INTO projects (id, name) VALUES (?, ?)').run(
        'existing-project',
        'Existing project'
      )
      db.exec(MIGRATIONS[15])
      expect(
        db
          .prepare('SELECT name, external_libraries FROM projects WHERE id = ?')
          .get('existing-project')
      ).toEqual({ name: 'Existing project', external_libraries: null })
    } finally {
      db.close()
    }
  })
})
