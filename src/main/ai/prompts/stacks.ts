import { promptText } from './i18n'
import type { PromptLanguage } from './i18n'
import type { PreviewLib, Stack } from '../../../shared/types'

/**
 * 技术栈约束段。必须与 preview 运行时(src/main/preview)的真实能力
 * 严格对齐——这里许诺了什么,iframe 里就必须跑得起来什么。
 *
 * 三种栈共用同一套样式方案(Tailwind v4 + theme.css),所以设计体系规范
 * 对三种栈是同一份,换栈不换规范。
 */

function commonRuntime(lang: PromptLanguage): string {
  return promptText(lang, 'stack.runtime').trim()
}

/**
 * TypeScript 的两条硬规则。
 *
 * 第二条不是风格问题而是**会白屏的错误**:预览是按文件单独编译的,编译器
 * 看不到别的文件,分不清 \`export { User } from './types'\` 里的 User 是类型
 * 还是值,只能当值原样保留。而 types.ts 编译完只剩一个空模块,于是浏览器在
 * 链接阶段报 "does not provide an export named 'User'",整个模块图加载失败。
 *
 * 普通的 \`import { User } from './types'\` 没有这个问题——编译器在**本文件内**
 * 能看到 User 只用在类型位置,会把整条 import 消掉。只有再导出躲不过。
 */
function typeScriptRules(lang: PromptLanguage): string {
  return promptText(lang, 'stack.typescript')
}

function stackTexts(lang: PromptLanguage): Record<Stack, string> {
  return {
    html: promptText(lang, 'stack.html', { runtime: commonRuntime(lang) }),
    vue3: promptText(lang, 'stack.vue3', {
      typeRules: typeScriptRules(lang),
      runtime: commonRuntime(lang)
    }),
    react: promptText(lang, 'stack.react', {
      typeRules: typeScriptRules(lang),
      runtime: commonRuntime(lang)
    })
  }
}

/**
 * 组件库段,按项目勾选注入。规则要点:
 * - 有组件库时,交互控件优先用它——自己拿 div 手搓一个次品按钮是浪费;
 * - 但布局、间距、配色仍然走 Tailwind + theme.css,组件库管"控件",不管"版面";
 * - 图标从图标包引,继续禁止 emoji。
 */
function libraryTexts(lang: PromptLanguage): Record<PreviewLib, string> {
  return {
    'antdv-next': promptText(lang, 'stack.library.antdvNext'),
    '@antdv-next/icons': promptText(lang, 'stack.library.icons')
  }
}

export function stackPrompt(
  stack: Stack,
  libs: PreviewLib[] = [],
  lang: PromptLanguage = 'zh-CN'
): string {
  const base = stackTexts(lang)[stack].trim()
  // 组件库目前只在 vue3 栈的预览环境里装了运行时,别的栈勾了也没用
  if (stack !== 'vue3' || libs.length === 0) return base
  const sections = libs.map((lib) => libraryTexts(lang)[lib]?.trim()).filter(Boolean)
  return [base, ...sections].join('\n\n')
}
