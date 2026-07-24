import { sql } from 'drizzle-orm'
import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

/**
 * 表结构的唯一事实来源。
 *
 * 列名写 snake_case、属性名用 camelCase，映射在这里声明一次，
 * 不用再手写 Row 接口和转换函数。改完这里跑 `pnpm db:generate`
 * 生成迁移 SQL。
 */
export const projects = sqliteTable(
  'projects',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    name: text('name').notNull(),
    createdAt: text('created_at')
      .notNull()
      .default(sql`(datetime('now'))`),
    updatedAt: text('updated_at')
      .notNull()
      .default(sql`(datetime('now'))`)
  },
  (table) => [index('idx_projects_updated_at').on(table.updatedAt)]
)

export type Project = typeof projects.$inferSelect
export type NewProject = typeof projects.$inferInsert
