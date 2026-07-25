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

## 用法:App.vue 最外层包 a-config-provider

```vue
<script setup lang="ts">
import { theme } from 'antdv-next'

const rootStyle = getComputedStyle(document.documentElement)
const readToken = (name: string) => rootStyle.getPropertyValue(name).trim()
const readNumberToken = (name: string) => Number.parseFloat(readToken(name))
const isDark = document.documentElement.dataset.theme === 'dark'

const themeConfig = {
  algorithm: isDark ? theme.darkAlgorithm : theme.defaultAlgorithm,
  token: {
    colorPrimary: readToken('--color-brand-500'), // 必须 = theme.css
    colorBgBase: readToken('--color-bg'),
    colorTextBase: readToken('--color-ink'),
    borderRadius: readNumberToken('--radius-base'),
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

示例直接读取本项目已生成的 `theme.css`，可在 Vue 浏览器预览中运行。`data-theme` 只用于
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
