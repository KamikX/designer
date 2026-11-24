import { promptText } from '../ai/prompts/i18n'
import type { PromptLanguage } from '../ai/prompts/i18n'
import type { FileSkill } from './scan'

/**
 * 技能目录:注入 system prompt 的那一层(渐进披露的 L1)。
 *
 * ## 三层分别是什么
 *
 * | 层 | 内容 | 时机 | 量级 |
 * | --- | --- | --- | --- |
 * | L1 目录 | name + description | 每轮 | 实测 35 个技能 7139 字符 |
 * | L2 正文 | SKILL.md 全文 | activate_skill 时 | 几千字符 |
 * | L3 资源 | references/ 下的文档 | 正文引用到时 | 按需 |
 *
 * 对照:这 35 个技能的正文合计 159,253 字符。**整段注入不是"贵一点",是根本
 * 塞不下**——而且其中绝大部分与当下要做的事无关。
 *
 * ## 为什么用 XML 而不是 markdown 列表
 *
 * 这是规范里的规范化形状。description 里本身就有换行和标点,用列表的话模型会
 * 把描述的第二行当成新条目。标签的边界是明确的。
 */

/** 上下文窗口未知时的目录预算(字符) */
const FALLBACK_BUDGET = 8000
/** 占上下文窗口的比例。抄 Codex 的取值 */
const BUDGET_RATIO = 0.02
/** 粗略的 token→字符换算。中英混排取 3,宁可估紧一点 */
const CHARS_PER_TOKEN = 3
/** 缩短描述时的下限。再短就看不出触发条件了,那这条目录等于没有 */
const MIN_DESCRIPTION = 80

export function skillCatalog(
  skills: FileSkill[],
  contextWindow?: number,
  lang: PromptLanguage = 'zh-CN'
): string {
  if (skills.length === 0) return ''

  const budget = contextWindow
    ? Math.max(FALLBACK_BUDGET / 2, contextWindow * BUDGET_RATIO * CHARS_PER_TOKEN)
    : FALLBACK_BUDGET

  const entries = fit(skills, budget)
  const body = entries
    .map(
      (s) =>
        `  <skill>\n    <name>${s.name}</name>\n    <description>${s.description}</description>\n    <location>${s.path}</location>\n  </skill>`
    )
    .join('\n')

  return promptText(lang, 'skills.catalog', { body: body }).trim()
}

/**
 * 塞进预算。
 *
 * **超预算时缩短描述,不丢条目。** 丢掉的那条模型永远不会知道它存在,而缩短的
 * 那条至少还留着名字和半句触发条件——用户问起来它能说"我有这个技能"。
 */
function fit(skills: FileSkill[], budget: number): FileSkill[] {
  const overhead = 90 // 每条的标签和路径大致占这么多
  const fixed = skills.reduce((n, s) => n + s.name.length + s.path.length + overhead, 0)
  const room = budget - fixed
  const wanted = skills.reduce((n, s) => n + s.description.length, 0)
  if (room >= wanted) return skills

  // 均分剩余空间,但不低于下限——低于下限的话触发条件已经被切没了
  const per = Math.max(MIN_DESCRIPTION, Math.floor(room / skills.length))
  return skills.map((s) =>
    s.description.length <= per ? s : { ...s, description: `${s.description.slice(0, per)}…` }
  )
}
