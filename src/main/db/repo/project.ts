import { desc, eq, sql } from 'drizzle-orm'
import type { CreateProjectInput, Project } from '../../../shared/types'
import { getDb } from '../index'
import { projects } from '../schema'
import type { ProjectRow } from '../schema'

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

// stack/designMode 在库里是宽松的 text，出库时收窄成联合类型。
// 运行时不做校验——写入口只有 createProject，入参本身就是联合类型
function toProject(row: ProjectRow): Project {
  return row as Project
}

export function listProjects(): Project[] {
  return getDb().select().from(projects).orderBy(desc(projects.updatedAt)).all().map(toProject)
}

export function getProject(id: string): Project | null {
  const row = getDb().select().from(projects).where(eq(projects.id, id)).get()
  return row ? toProject(row) : null
}

export function createProject(input: CreateProjectInput): Project {
  return toProject(
    getDb()
      .insert(projects)
      .values({
        name: input.name,
        stack: input.stack,
        designMode: input.designMode,
        description: input.description ?? ''
      })
      .returning()
      .get()
  )
}

export function renameProject(id: string, name: string): Project | null {
  const row = getDb()
    .update(projects)
    .set({ name, updatedAt: sql`(datetime('now'))` })
    .where(eq(projects.id, id))
    .returning()
    .get()
  return row ? toProject(row) : null
}

export function touchProject(id: string): void {
  getDb()
    .update(projects)
    .set({ updatedAt: sql`(datetime('now'))` })
    .where(eq(projects.id, id))
    .run()
}

export function deleteProject(id: string): void {
  getDb().delete(projects).where(eq(projects.id, id)).run()
}
