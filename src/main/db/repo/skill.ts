import { asc, eq, sql } from 'drizzle-orm'
import type { Skill, SkillInput } from '../../../shared/types'
import { getDb } from '../index'
import { skills } from '../schema'
import type { SkillRow } from '../schema'

/** 技能仓储:可复用的提示词包。启用的技能将注入设计对话(链路接入在后续里程碑)。 */

function toView(row: SkillRow): Skill {
  return row as Skill
}

export function listSkills(): Skill[] {
  return getDb().select().from(skills).orderBy(asc(skills.createdAt)).all().map(toView)
}

export function createSkill(input: SkillInput): Skill {
  return toView(
    getDb()
      .insert(skills)
      .values({ name: input.name, description: input.description ?? '', content: input.content })
      .returning()
      .get()
  )
}

export function updateSkill(
  id: string,
  patch: Partial<SkillInput> & { enabled?: boolean }
): Skill | null {
  const row = getDb()
    .update(skills)
    .set({
      ...(patch.name != null ? { name: patch.name } : {}),
      ...(patch.description != null ? { description: patch.description } : {}),
      ...(patch.content != null ? { content: patch.content } : {}),
      ...(patch.enabled != null ? { enabled: patch.enabled } : {}),
      updatedAt: sql`(datetime('now'))`
    })
    .where(eq(skills.id, id))
    .returning()
    .get()
  return row ? toView(row) : null
}

export function deleteSkill(id: string): void {
  getDb().delete(skills).where(eq(skills.id, id)).run()
}
