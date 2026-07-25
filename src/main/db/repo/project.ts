import { desc, eq, sql } from 'drizzle-orm'
import type { CreateProjectInput, Project, ProjectSettings } from '../../../shared/types'
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

/**
 * 合并保存工作台选择。
 *
 * 用合并而不是整体覆盖:模型选择器和技能勾选是两个独立组件,各自变化时
 * 各存各的。整体覆盖会让后写的那个把前一个刚存的抹掉。
 *
 * 不动 updatedAt——它决定项目列表的排序,"换了个模型"不该让项目跳到最前面。
 */
export function saveProjectSettings(id: string, patch: ProjectSettings): void {
  const current = getProject(id)
  if (!current) return
  getDb()
    .update(projects)
    .set({ settings: { ...current.settings, ...patch } })
    .where(eq(projects.id, id))
    .run()
}
