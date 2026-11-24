import { validateVisualGuidance } from '../../../shared/visual-guidance'
import { desc, eq, sql } from 'drizzle-orm'
import type {
  CreateProjectInput,
  DesignTarget,
  ExternalLibraryRef,
  PreviewLib,
  Project,
  ProjectSettings,
  VisualGuidance
} from '../../../shared/types'
import { getDb } from '../index'
import { projects, artifacts } from '../schema'
import { resolveLibraries } from '../../libraries/service'
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

// Keep legacy rows readable without rewriting their persisted configuration.
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

const DESIGN_TARGETS: readonly DesignTarget[] = ['mobile', 'web', 'landing', 'admin', 'components']

/** IPC callers can bypass the wizard, so enforce the component boundary before persistence. */
function validateTargets(targets: unknown): DesignTarget[] | null {
  if (targets === undefined) return null
  if (
    !Array.isArray(targets) ||
    Array.from(targets).some((target) => !DESIGN_TARGETS.includes(target))
  ) {
    throw new Error('Invalid design targets')
  }
  const unique = [...new Set(targets)] as DesignTarget[]
  if (unique.includes('components') && unique.length > 1) {
    throw new Error('Component development cannot be combined with page targets')
  }
  return unique.length ? unique : null
}

export function createProject(input: CreateProjectInput): Project {
  const targets = validateTargets(input.targets)
  const guidance = validateVisualGuidance({
    styleBrief: input.styleBrief === undefined ? '' : input.styleBrief,
    designDocument: input.designDocument === undefined ? '' : input.designDocument,
    visualStylePriority:
      input.visualStylePriority === undefined ? 'styleBrief' : input.visualStylePriority
  })
  resolveLibraries(input.externalLibraries ?? [], input.stack, input.libs ?? [])
  return toProject(
    getDb()
      .insert(projects)
      .values({
        externalLibraries: input.externalLibraries?.length ? input.externalLibraries : null,
        name: input.name,
        stack: input.stack,
        designMode: input.designMode,
        // 空数组归一成 null:两者都是"没选",不该以两种形态存在库里
        targets,
        libs: input.libs?.length ? input.libs : null,
        description: input.description ?? '',
        codeInstructions: '',
        ...guidance
      })
      .returning()
      .get()
  )
}

/** Keep visual sources and their precedence atomic so subsequent turns never see a mixed draft. */
export function setProjectVisualGuidance(id: string, guidance: VisualGuidance): Project | null {
  if (typeof id !== 'string' || !id) throw new Error('Invalid project ID')
  const validated = validateVisualGuidance(guidance)
  const row = getDb()
    .update(projects)
    .set({ ...validated, updatedAt: sql`(datetime('now'))` })
    .where(eq(projects.id, id))
    .returning()
    .get()
  return row ? toProject(row) : null
}

export function setProjectStyleBrief(id: string, styleBrief: string): Project | null {
  if (typeof styleBrief !== 'string') throw new Error('Invalid visual style')
  const row = getDb()
    .update(projects)
    .set({ styleBrief: styleBrief.trim(), updatedAt: sql`(datetime('now'))` })
    .where(eq(projects.id, id))
    .returning()
    .get()
  return row ? toProject(row) : null
}

/**
 * 修改依赖包。和 stack 不同,libs 不牵动文件树,创建后改是安全的:
 * 影响面只有预览引导页(import map + app.use)和提示词,下一轮/下一次
 * 刷新自然生效。
 */
export function setProjectLibs(id: string, libs: PreviewLib[]): Project | null {
  const row = getDb()
    .update(projects)
    .set({ libs: libs.length ? libs : null, updatedAt: sql`(datetime('now'))` })
    .where(eq(projects.id, id))
    .returning()
    .get()
  return row ? toProject(row) : null
}

export function setProjectDescription(id: string, description: string): Project | null {
  if (typeof id !== 'string' || !id) throw new Error('Invalid project ID')
  if (typeof description !== 'string') throw new Error('Invalid project description')
  const row = getDb()
    .update(projects)
    .set({ description: description.trim(), updatedAt: sql`(datetime('now'))` })
    .where(eq(projects.id, id))
    .returning()
    .get()
  return row ? toProject(row) : null
}

export function setProjectCodeInstructions(id: string, instructions: string): Project | null {
  if (typeof id !== 'string' || !id) throw new Error('Invalid project ID')
  if (typeof instructions !== 'string') throw new Error('Invalid project code instructions')
  const row = getDb()
    .update(projects)
    .set({ codeInstructions: instructions.trim(), updatedAt: sql`(datetime('now'))` })
    .where(eq(projects.id, id))
    .returning()
    .get()
  return row ? toProject(row) : null
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
  if (Object.hasOwn(patch, 'selectedArtifactId') && patch.selectedArtifactId !== null) {
    if (typeof patch.selectedArtifactId !== 'string') throw new Error('Invalid selected version')
    const artifact = getDb()
      .select()
      .from(artifacts)
      .where(eq(artifacts.id, patch.selectedArtifactId))
      .get()
    if (!artifact || artifact.projectId !== id) throw new Error('Invalid selected project version')
  }
  getDb()
    .update(projects)
    .set({ settings: { ...current.settings, ...patch } })
    .where(eq(projects.id, id))
    .run()
}

export function setProjectExternalLibraries(
  id: string,
  refs: ExternalLibraryRef[]
): Project | null {
  const project = getProject(id)
  if (!project) return null
  resolveLibraries(refs, project.stack, project.libs ?? [])
  const row = getDb()
    .update(projects)
    .set({ externalLibraries: refs.length ? refs : null, updatedAt: sql`(datetime('now'))` })
    .where(eq(projects.id, id))
    .returning()
    .get()
  return row ? toProject(row) : null
}
