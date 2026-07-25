---
name: antdv-theme
description: antdv-next 主题定制。Use when 项目勾选了 antdv-next 依赖包、要定组件主题、或者组件看起来还是默认蓝的时候。定主题是用组件库项目的第一步,和 theme.css 一起定。不适用:没勾组件库的项目。
metadata:
  kind: craft
---

# antdv-next 主题定制

组件库的默认蓝(#1677ff)原样交付 = 没做设计。antdv-next 的主题体系
(与 ant-design v5 同源:token 算法 + 语义化结构)能做到"随心所欲"——
用它,别让所有项目的控件长一个样。

## 用法:App.vue 最外层包 a-config-provider

```vue
<script setup lang="ts">
import { theme } from 'antdv-next'

const themeConfig = {
  token: {
    colorPrimary: '#2f7d5c',        // 必须 = theme.css 的 --color-brand-500
    borderRadius: 8,                 // 必须 = --radius-base 同档
    fontFamily: 'inherit'            // 跟页面字体,别让控件换一副面孔
  },
  algorithm: theme.defaultAlgorithm  // 或 [theme.darkAlgorithm, theme.compactAlgorithm] 组合
}
</script>

<template>
  <a-config-provider :theme="themeConfig">
    <!-- 页面内容 -->
  </a-config-provider>
</template>
```

## 三层定制,从粗到细

| 层 | 改什么 | 例 |
| --- | --- | --- |
| algorithm 算法 | 整体风格骨架,可数组组合 | `defaultAlgorithm` / `darkAlgorithm` / `compactAlgorithm` |
| token(Seed Token) | 设计意图源头,派生一整族 | `colorPrimary` `borderRadius` `fontSize` `colorBgBase` `colorTextBase` `wireframe` |
| components 组件变量 | 单组件定向覆盖,互不影响 | `components: { Button: { controlHeight: 40 }, Table: { headerBg: '#f7f6f3' } }` |

常用 Seed Token:`colorPrimary`(主色)、`borderRadius`(圆角基准)、
`fontSize`(基准字号,默认 14)、`fontFamily`、`colorBgBase` / `colorTextBase`
(底色与文字的基调,冷暖色温在这里对齐页面)、`wireframe: true`(线框风,
填充变描边,整体立刻安静下来)。改 Seed 会自动派生梯度色,不用手调每一级。

## 风格配方:选一组,判读时说出来

**用户给了方向听用户的**;没给就按 brief 气质从下表选,
**连续两个项目不许选同一组**:

| 配方 | token / algorithm 组合 | 气质 |
| --- | --- | --- |
| 锐利工具 | `borderRadius: 2` + `compactAlgorithm` | 开发者工具、专业软件 |
| 线框极简 | `wireframe: true` + `borderRadius: 4` | 内容工具、极简品牌 |
| 圆润消费 | `borderRadius: 10` + `controlHeight: 40`(components.Button) | 生活方式、C 端产品 |
| 暗色控制台 | `[darkAlgorithm, compactAlgorithm]` + `colorBgBase` 微调色温 | 监控、数据密集 |
| 大字松弛 | `fontSize: 15` + `borderRadius: 8` | 教育、阅读向 |
| 品牌浸染 | 深色导航区整条用品牌色调(components.Menu 的 darkItemBg 系) | 品牌感强的中后台 |

## 硬规则

- **`colorPrimary` 必须等于 theme.css 的 `--color-brand-500`**。页面一套主色、
  控件另一套,是两套语言在打架——这条没有例外。
- 圆角、字体同理对齐 theme.css:`borderRadius` 与 `--radius-base` 同档,
  `fontFamily: 'inherit'` 跟页面。
- 暗色不换 CSS 文件,用 `darkAlgorithm`;页面侧的暗色(theme.css)要同步,
  别出现"控件黑了页面还白着"。
- 状态色(success/warning/error)保持默认,除非品牌明确要求——它们承担
  语义,乱调会让"危险"看起来不危险。
- 每个项目的 themeConfig 都该和上一个不一样:配方、圆角档、算法组合至少
  一项有差异。判读一行写清:「组件主题〈配方名〉,colorPrimary 对齐 brand,
  圆角〈N〉,算法〈组合〉」。
