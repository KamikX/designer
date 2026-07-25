import type { Skill } from '../../../shared/types'
import { BUILTIN_SKILLS } from './builtin-skills'

/**
 * 技能段组装。
 *
 * 技能面板、导入包、按会话勾选这一整套之前都只做到 UI——技能内容从来
 * 没进过 system prompt。这个模块是那条断掉的链路。
 *
 * 顺序有意为之:内置的强制技能放最前面。设计体系是骨架,用户自己的技能
 * 是补充,补充不该顶掉骨架。
 */

/** 单条技能的字符上限:技能是长期驻留在 system prompt 里的,失控就一直失控 */
const MAX_SKILL_CHARS = 6000

/** 技能总量上限 */
const MAX_TOTAL_CHARS = 24000

function clip(text: string, max: number): string {
  const trimmed = text.trim()
  if (trimmed.length <= max) return trimmed
  return `${trimmed.slice(0, max)}\n…(该技能内容过长,已截断)`
}

/**
 * 把技能正文塞进外层标题层级。
 *
 * 技能包(SKILL.md)习惯以 `# 标题` 开头,而我们已经用技能名出了一个
 * `###`。原样拼接会得到"### 名字"底下跟着"# 名字(强制)"——标题重复,
 * 层级还是倒的,模型读到的结构就散了。
 *
 * 处理:去掉开头那行 h1(它就是技能名),其余标题整体下沉两级。
 */
export function normalizeSkillBody(body: string): string {
  const withoutTitle = body.trim().replace(/^#\s+.*\n+/, '')
  // 下沉两级(技能名占了 ###),最深压到 h6
  return withoutTitle.replace(
    /^(#{1,6})\s/gm,
    (_, hashes: string) => `${`${hashes}##`.slice(0, 6)} `
  )
}

/**
 * @param userSkills 本会话启用的用户技能(已按 skillIds 过滤)
 */
export interface SkillsPromptOptions {
  /**
   * 是否带上内置技能。默认带。
   *
   * 纯聊天必须传 false:内置的两条(UI 设计体系规范、交互完备性)是**设计
   * 专属**的,用户开一个干净的聊天窗口不该被塞进一套设计规矩。
   */
  builtin?: boolean
}

export function skillsPrompt(userSkills: Skill[], options: SkillsPromptOptions = {}): string {
  const sections: string[] = []
  let budget = MAX_TOTAL_CHARS

  const take = (title: string, body: string): void => {
    if (budget <= 0) return
    const text = clip(normalizeSkillBody(body), Math.min(MAX_SKILL_CHARS, budget))
    budget -= text.length
    sections.push(`### ${title}\n\n${text}`)
  }

  if (options.builtin !== false) {
    for (const skill of BUILTIN_SKILLS) {
      if (skill.alwaysOn) take(skill.name, skill.content)
    }
  }
  for (const skill of userSkills) {
    take(skill.name, skill.content)
  }

  if (sections.length === 0) return ''
  return `## 必须遵守的规范\n\n${sections.join('\n\n')}`
}
