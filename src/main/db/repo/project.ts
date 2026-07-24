import { desc, eq, sql } from 'drizzle-orm'
import type { Project } from '../../../shared/types'
import { getDb } from '../index'
import { projects } from '../schema'

/**
 * 项目仓储。
 *
 * 渲染进程只能调到这一层的领域方法，拿不到原始 SQL——一旦暴露
 * db.query(sql)，渲染进程的任何 XSS 就等于拿到整库写权限，
 * contextIsolation 就白开了。
 *
 * snake_case → camelCase 的映射在 schema 里声明过了，这里不用手写转换。
 * 返回类型标注成 shared 的 Project：drizzle 反推出的行类型一旦和对外
 * 契约对不上，这几行的返回值就直接编译不过，不会悄悄漂移。
 */

export function listProjects(): Project[] {
  return getDb().select().from(projects).orderBy(desc(projects.updatedAt)).all()
}

export function getProject(id: number): Project | null {
  return getDb().select().from(projects).where(eq(projects.id, id)).get() ?? null
}

export function createProject(name: string): Project {
  return getDb().insert(projects).values({ name }).returning().get()
}

export function renameProject(id: number, name: string): Project | null {
  return (
    getDb()
      .update(projects)
      .set({ name, updatedAt: sql`(datetime('now'))` })
      .where(eq(projects.id, id))
      .returning()
      .get() ?? null
  )
}

export function deleteProject(id: number): void {
  getDb().delete(projects).where(eq(projects.id, id)).run()
}
