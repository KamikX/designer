---
name: antdv-theme
description: antdv-next 主题定制。Use when 项目勾选了 antdv-next 依赖包、要定组件主题、或者组件看起来还是默认蓝的时候。定主题是用组件库项目的第一步,和 theme.css 一起定。不适用:没勾组件库的项目。
metadata:
  kind: craft
---

# antdv-next 主题定制

组件库的默认蓝原样交付 = 没做设计。antdv-next 的主题体系
(与 ant-design v5 同源:token 算法 + 语义化结构)应把项目的 StyleBrief 翻译为组件语言，
而不是让所有项目的控件长一个样。

StyleBrief 高于本文示例。先从其中识别明暗、密度、几何、字体、色温、表面和品牌信号，
再映射为 algorithm、seed token 与 component token；不存在必须套用的默认配方。

When project guidance includes DESIGN.md, references to StyleBrief in this skill mean the combined
Visual style and DESIGN.md rules under the project's selected source priority. This affects visual
choices only; skill activation, workflows, technical contracts and accessibility still apply.

## 用法:App.vue 最外层包 a-config-provider

```vue
<script setup lang="ts">
import { theme } from 'antdv-next'

const rootStyle = getComputedStyle(document.documentElement)
const readToken = (name: string) => rootStyle.getPropertyValue(name).trim()
const readLengthTokenInPixels = (name: string, fallbackPixels = 0) => {
  const value = readToken(name)
  if (!value) return fallbackPixels

  const probe = document.createElement('div')
  probe.style.position = 'fixed'
  probe.style.visibility = 'hidden'
  probe.style.pointerEvents = 'none'
  probe.style.contain = 'strict'
  probe.style.width = value
  document.body.append(probe)

  try {
    // 浏览器负责解析 px/rem/clamp()/var()，读取结果时只接受有限的像素值。
    const resolved = getComputedStyle(probe).width
    const match = /^(-?(?:\d+|\d*\.\d+))px$/.exec(resolved)
    const pixels = match ? Number(match[1]) : Number.NaN
    return Number.isFinite(pixels) ? pixels : fallbackPixels
  } finally {
    probe.remove()
  }
}
const isDark = document.documentElement.dataset.theme === 'dark'

const themeConfig = {
  algorithm: isDark ? theme.darkAlgorithm : theme.defaultAlgorithm,
  token: {
    colorPrimary: readToken('--color-brand-500'), // 必须 = theme.css
    colorBgBase: readToken('--color-bg'),
    colorTextBase: readToken('--color-ink'),
    borderRadius: readLengthTokenInPixels('--radius-base'),
    fontFamily: readToken('--font-body')
  }
}
</script>

<template>
  <a-config-provider :theme="themeConfig">
    <!-- 页面内容 -->
  </a-config-provider>
</template>
```

示例直接读取本项目已生成的 `theme.css`，可在 Vue 浏览器预览中运行。长度 token 交给 DOM
计算，因此 `px`、`rem`、`clamp()` 和 `var()` 都会转换成 antdv-next 所需的像素 number；
缺失、无法计算或非有限结果使用显式 fallback，绝不把 `NaN` 写入主题。`data-theme` 只用于
表达项目已确认的明暗模式；需要紧凑算法或组件 token 时，按 StyleBrief 在同一对象中添加，
不要把示例中的任何组合抄成默认。

## 三层开放翻译,从信号到组件

| 层              | 改什么                     | StyleBrief 信号到实现的示例                                                                   |
| --------------- | -------------------------- | --------------------------------------------------------------------------------------------- |
| algorithm 算法  | 整体明暗与密度骨架，可组合 | 深色信号可映射 `darkAlgorithm`；密集工作流可叠加 `compactAlgorithm`；其余情况由项目主题决定。 |
| seed token      | 设计意图源头，派生一整族   | 品牌色映射 `colorPrimary`；字体、圆角、字号、背景和文字基调映射对应 seed token。              |
| component token | 单组件定向覆盖，互不影响   | 表格表头、按钮高度、菜单表面或输入边界只在 StyleBrief 需要时，从同一份语义 token 映射。       |

常用 Seed Token 包括 `colorPrimary`、`borderRadius`、`fontSize`、`fontFamily`、
`colorBgBase`、`colorTextBase` 与 `wireframe`。改 Seed 会自动派生色阶，但每一个输入值都
必须追溯到 StyleBrief 和 `theme.css`，而非示例或组件库习惯。

## 硬规则

- **`colorPrimary` 必须等于 theme.css 的 `--color-brand-500`**。页面一套主色、
  控件另一套,是两套语言在打架——这条没有例外。
- 圆角、字体同理对齐 theme.css:`borderRadius` 与 `--radius-base` 同档，
  `fontFamily` 与项目的字体 token 一致。
- 明暗 algorithm 与页面侧 `theme.css` 同步，别出现控件和页面处于相反主题的情况。
- 状态色(success/warning/error)必须保持清晰语义、足够对比度和非色彩辅助线索；品牌需求
  不能牺牲“危险”“成功”等含义。
- 判读一行写清：StyleBrief 的哪些信号分别映射到 algorithm、seed token、component token，
  并确认它们和 `theme.css` 一致。

## antd 组件语言的结构契约(与主题无关,移植自 antdv-next DESIGN.md)

下面这些是 antd 交互语义的**结构**约定,换任何主题都成立。用 antdv-next 时遵守它们,
产出才读得出"这是一个 antd 应用";颜色和几何的具体取值仍由 StyleBrief 决定。

- **同屏只有一个 primary 按钮**。两个决定并列时,降一个为 default——这是决定性
  层级,不是配色偏好。
- **控件同高对齐**:按钮、输入框、选择器共享同一控件高度(默认档 32px,紧凑/宽松
  按 algorithm 或 component token 整体换档),不要单独改一个。
- **表面走三层模型**:布局底(layout)/容器(container)/表面(surface),按角色引用,
  不按色值硬写。相邻元素圆角不混档:卡片里的按钮圆角不能比卡片还大。
- **导航"你在这里"只用一个视觉线索**:菜单选中 = 浅品牌底 + 品牌字;tabs 激活 =
  品牌字 + 2px 下划线,任何状态都不加底色填充。两者不叠加第二种强调。
- **表格默认不做斑马纹**,只在 hover 行高亮;表头用容器层表面 + 标题字重。
- **预设色板(blue…lime)只用于 tag、图表和分类可视化**,不为单个界面另造强调色;
  tag 不用来承载关键状态——那是 Alert/Badge 的职责。
- **Alert 用淡语义底 + 正常文字色**,状态靠图标与底色传达,不靠低对比的彩色正文。
- **全圆角(full)只给头像、徽标、圆点**,不给按钮和 tag;直角只给表格和分段控件内缘。
- **动效用既有 motion token 档位**(组件级过渡默认 0.2s 一档),不自造 bezier。

**默认基线认知**:antdv-next 的出厂样子是 #1677FF 主色、6px 圆角、系统字体栈。
知道这个基线是为了**偏离它**——产出里这些值原样出现且 StyleBrief 没点名,就是
"默认蓝原样交付",slop-lint 的 antd-unthemed 会拦。
