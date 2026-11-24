import { promptText } from './i18n'
import type { PromptLanguage } from './i18n'
/**
 * 手艺核心:**唯一常驻**的设计规则。
 *
 * ## 为什么是"精华常驻 + 细节按需"
 *
 * 完整的手艺规则(字距表、配色预算、层级手段、动效时长、反 AI 味清单)一共
 * 一万四千字,放在 \`resources/skills/craft-*\` 里,由模型按需 activate_skill 加载。
 *
 * 历史教训:曾经把常驻部分压到不足一千字,指望模型"动手排版前先按需加载"。
 * 实测它不会——套模板的时候恰恰意识不到需要反模板规则,渐进披露对知识型技能
 * 成立,对审美护栏不成立。所以下面这份**压缩硬规则**无条件常驻:它们是被违反
 * 频率最高、违反后一眼可见的那部分,全文控制在三千字内。展开的解释、表格和
 * 特例仍在技能里,细节拿不准时再去取。
 */
export function craftCore(lang: PromptLanguage): string {
  return promptText(lang, 'craft.baseline').trim()
}
export const CRAFT_CORE = craftCore('zh-CN')
