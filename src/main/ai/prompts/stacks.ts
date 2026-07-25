import type { PreviewLib, Stack } from '../../../shared/types'

/**
 * 技术栈约束段。必须与 preview 运行时(src/main/preview)的真实能力
 * 严格对齐——这里许诺了什么,iframe 里就必须跑得起来什么。
 *
 * 三种栈共用同一套样式方案(Tailwind v4 + theme.css),所以设计体系规范
 * 对三种栈是同一份,换栈不换规范。
 */

const COMMON_RUNTIME = `
### 样式

- 一律用 Tailwind 工具类(预览环境内置 Tailwind v4,无需引入任何东西)。
- **设计 token 全部写在 \`theme.css\` 里**,用 \`@theme { ... }\` 声明;
  预览环境会自动加载它,页面里不需要 link 或 import。
- **theme.css 里不要写 \`@import 'tailwindcss'\`**——运行时已经内置了,
  写了会重复加载直接冲突。这个文件只放 @theme 与自定义样式层。
- 页面里只用 token 派生的类名(\`bg-surface\` \`text-ink\` \`bg-brand-500\`),
  不写 \`bg-[#...]\`,也不用 Tailwind 自带的 \`gray-\` \`blue-\` 这类调色板——
  那样换主题时改不动。
- Tailwind 覆盖不了的(关键帧动画、复杂选择器)可以写少量 <style>。

### 资源

不要引用任何外部网络资源(CDN 脚本 / 字体 / 图片)。图标一律内联 SVG;
配图用纯 CSS 或内联 SVG 画,不要用外链图片,也不要拿 emoji 当图标。
`.trim()

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
const TS_RULES = `
### TypeScript 约定

- 类型尽量准确,但不要为了类型正确写出冗长的泛型;这是设计稿,不是类库。
- **再导出类型必须写 \`export type\`**:
  ✅ \`export type { User } from './types'\`
  ❌ \`export { User } from './types'\` —— 会导致整个页面加载失败
`

const STACKS: Record<Stack, string> = {
  html: `
## 技术栈:纯 HTML

- 入口固定为 index.html,浏览器直接打开即可运行。
- 可拆分多个 html/css/js 文件,相互用相对路径引用。
- 交互用原生 JavaScript(<script> 或独立 .js 文件)。
${COMMON_RUNTIME}
`,
  vue3: `
## 技术栈:Vue 3 单文件组件(TypeScript)

- 入口固定为 App.vue,不要写 main.ts/index.html,运行环境已备好挂载逻辑。
- 组件拆分为多个 .vue 文件,用相对路径 import(如 import Header from './components/Header.vue')。
- **一律 \`<script setup lang="ts">\`**。用户明确要求 JavaScript 时才去掉 lang="ts"。
- props / emits 用类型声明,不要用运行时对象写法:
  \`const props = defineProps<{ title: string; items?: Item[] }>()\`
  \`const emit = defineEmits<{ pick: [id: number] }>()\`
  编译器会据此生成运行时校验,比手写对象更准也更短。
- 抽出来的工具函数写 .ts 文件;只允许 import 相对路径的 .vue/.ts 文件和 'vue' 本身。
${TS_RULES}
${COMMON_RUNTIME}
`,
  react: `
## 技术栈:React(TypeScript)

- 入口固定为 App.tsx,默认导出根组件;不要写 index.html/main.tsx,运行环境已备好挂载逻辑。
- **组件一律用 .tsx**,工具函数用 .ts。用户明确要求 JavaScript 时才用 .jsx/.js。
- 函数组件 + hooks;props 用 interface 或 type 声明。
- 不需要写 \`import React\`,运行环境会自动注入。
- 只允许 import 相对路径的 .tsx/.ts 文件和 'react' / 'react-dom',不要引其他 npm 包。
${TS_RULES}
${COMMON_RUNTIME}
`
}

/**
 * 组件库段,按项目勾选注入。规则要点:
 * - 有组件库时,交互控件优先用它——自己拿 div 手搓一个次品按钮是浪费;
 * - 但布局、间距、配色仍然走 Tailwind + theme.css,组件库管"控件",不管"版面";
 * - 图标从图标包引,继续禁止 emoji。
 */
const LIB_PROMPTS: Record<PreviewLib, string> = {
  'antdv-next': `
### 组件库:antdv-next(预览环境已加载,直接 import)

- 组件库已全局安装:模板里直接写 \`<a-button>\` \`<a-table>\` \`<a-modal>\` 这类
  标签即可;需要具名引入的(theme、message 等)从 'antdv-next' import。
- 样式已全局就绪。**不要 import 任何 css 文件**——浏览器 ESM 不支持,写了直接白屏。
- **能用组件库就用组件库,不要手搓**。不只交互控件:表单(Form/Input/Select/
  DatePicker)、数据展示(Table/Descriptions/Statistic/Tag/Empty/Skeleton)、
  反馈(Modal/Drawer/Message/Popconfirm)、导航(Menu/Tabs/Breadcrumb/Pagination)
  都优先从组件库取——它的键盘、焦点、无障碍、边界态是手搓追不上的。
  动手写一个自定义控件之前,先确认组件库里真的没有。
- **版面与风格仍归 Tailwind + theme.css**:页面布局、间距、卡片、配色不要
  依赖组件库的栅格和默认主题色,设计感来自你的 token,组件库只是控件来源。
- **主题必须定制,默认蓝原样交付 = 没做设计**:App.vue 最外层包
  \`<a-config-provider :theme>\`,colorPrimary 对齐 theme.css 的 brand、
  圆角与字体同档、算法按气质选(dark/compact 可组合)。完整 token 清单、
  算法组合与六套风格配方,**动手前先 activate_skill 加载 antdv-theme**。
`,
  '@antdv-next/icons': `
### 图标库:@antdv-next/icons(预览环境已加载)

- **所有图标尽可能从这里取**:\`import { SearchOutlined, ... } from '@antdv-next/icons'\`。
  这条**覆盖**前面"图标一律内联 SVG"的默认规则——那是没有图标库时的兜底;
  现在只有图标库里确实没有的图形才允许内联 SVG 补位,emoji 仍然禁止。
- 通栏默认用 Outlined 一族;同一界面不要混用 Outlined / Filled 两种风格。
`
}

export function stackPrompt(stack: Stack, libs: PreviewLib[] = []): string {
  const base = STACKS[stack].trim()
  // 组件库目前只在 vue3 栈的预览环境里装了运行时,别的栈勾了也没用
  if (stack !== 'vue3' || libs.length === 0) return base
  const sections = libs.map((lib) => LIB_PROMPTS[lib]?.trim()).filter(Boolean)
  return [base, ...sections].join('\n\n')
}
