import type { Stack } from '../../../shared/types'

/**
 * 技术栈约束段。必须与 preview 运行时(src/main/preview)的真实能力
 * 严格对齐——这里许诺了什么,iframe 里就必须跑得起来什么。
 */

const COMMON_RUNTIME = `
样式使用 Tailwind CSS 工具类(预览环境内置 Tailwind JIT,无需引入)。
可以少量使用 <style> 写 Tailwind 覆盖不了的样式。
不要引用任何外部网络资源(CDN 脚本/字体/图片)。图片一律用纯 CSS、
内联 SVG 或 https://placehold.co 之外的占位方案(推荐内联 SVG)。
`.trim()

const STACKS: Record<Stack, string> = {
  html: `
## 技术栈:纯 HTML

- 入口固定为 index.html,浏览器直接打开即可运行。
- 可拆分多个 html/css/js 文件,相互用相对路径引用。
- 交互用原生 JavaScript(<script> 或独立 .js 文件)。
${COMMON_RUNTIME}
`,
  vue3: `
## 技术栈:Vue 3 单文件组件

- 入口固定为 App.vue,不要写 main.ts/index.html,运行环境已备好挂载逻辑。
- 组件拆分为多个 .vue 文件,用相对路径 import(如 import Header from './components/Header.vue')。
- 一律 <script setup> 组合式 API;可以 import { ref, computed } 等 vue API。
- 只允许 import 相对路径的 .vue/.js 文件和 'vue' 本身,不要引其他 npm 包。
${COMMON_RUNTIME}
`,
  react: `
## 技术栈:React

- 入口固定为 App.jsx,默认导出根组件;不要写 index.html/main.jsx,运行环境已备好挂载逻辑。
- 组件拆分为多个 .jsx 文件,用相对路径 import。
- 函数组件 + hooks;可以 import { useState } 等 react API。
- 只允许 import 相对路径的 .jsx/.js 文件和 'react' / 'react-dom',不要引其他 npm 包。
${COMMON_RUNTIME}
`
}

export function stackPrompt(stack: Stack): string {
  return STACKS[stack].trim()
}
