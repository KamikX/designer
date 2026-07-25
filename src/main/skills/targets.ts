import { readFileSync } from 'fs'
import type { DesignTarget } from '../../shared/types'
import type { FileSkill } from './scan'

/**
 * 按项目勾选的端,取出对应端模板(resources/skills/target-*)的正文。
 *
 * 走已扫描的 fileSkills 而不是自己拼路径:扫描层已经处理了来源优先级
 * (用户在 ~/.antd-designer/skills 放一个同名 target-mobile 就能覆盖内置版)、
 * asar 解包路径和符号链接去重,这里再实现一遍只会跟它漂移。
 */

export interface TargetTemplate {
  /** 技能名(target-mobile 等),chat-service 用它把该技能从 L1 目录里去掉 */
  name: string
  /** SKILL.md 去 frontmatter 后的正文 */
  body: string
}

/** 单个模板的注入上限。内置模板都在 3K 内,超出说明用户覆盖版跑飞了,截断保底 */
const MAX_TEMPLATE_CHARS = 8000

export function targetSkillName(target: DesignTarget): string {
  return `target-${target}`
}

export function loadTargetTemplates(
  skills: FileSkill[],
  targets: DesignTarget[]
): TargetTemplate[] {
  const out: TargetTemplate[] = []
  for (const target of targets) {
    const name = targetSkillName(target)
    const skill = skills.find((s) => s.name === name)
    // 找不到不算错:用户删了内置技能目录,注入少一段,其余照常
    if (!skill) continue
    let raw: string
    try {
      raw = readFileSync(skill.path, 'utf-8')
    } catch {
      continue
    }
    const body = raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '').trim()
    if (body) out.push({ name, body: body.slice(0, MAX_TEMPLATE_CHARS) })
  }
  return out
}
