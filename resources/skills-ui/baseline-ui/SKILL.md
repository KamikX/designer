---
name: baseline-ui
description: 快速给界面做一遍去 AI 味的基线清理:间距、层级、排版、动效与小布局问题。Use when 界面需要快速打磨、或对现有设计稿做基线体检的时候。
---

# Baseline UI

一份可核对的界面基线。逐条过当前设计稿,violations 引用原文片段、一句话说明为什么、
给出代码级修复。

**运行时前提**:设计稿在无 npm 依赖的预览环境里运行——没有 motion/react、没有
Radix/Base UI、没有 cn()。动效手写 CSS transition/animation,键盘与焦点语义用原生
HTML(button/dialog/details)加必要的 aria 手写。不要建议安装任何包。

## 交互

- MUST 破坏性/不可逆操作先确认(原生 dialog 或项目的确认弹层)
- SHOULD 加载态用结构化骨架,不用转圈占满屏
- NEVER 用 `h-screen`,用 `h-dvh`
- MUST 固定定位元素尊重 `safe-area-inset`
- MUST 错误提示出现在动作发生的位置旁边
- NEVER 阻止 input / textarea 的粘贴
- MUST 纯图标按钮带 `aria-label`
- MUST 可操作元素可键盘到达,焦点可见

## 动效

- NEVER 主动加动画,除非它服务空间/状态重定向
- MUST 只动合成器属性(`transform`、`opacity`)
- NEVER 动布局属性(`width`、`height`、`top`、`left`、`margin`、`padding`)
- SHOULD 进场用 ease-out;交互反馈不超过 200ms
- MUST 循环动画离屏时暂停;尊重 `prefers-reduced-motion`
- NEVER 对大图或全屏表面做动画;NEVER 动大面积 `blur()`/`backdrop-filter`

## 排版

- MUST 标题用 `text-balance`,段落用 `text-pretty`
- MUST 数据用 `tabular-nums`
- SHOULD 密集界面用 `truncate` / `line-clamp`
- 字距遵守 craft-typography(全大写 ≥0.06em、大标题收负字距)

## 布局与视觉

- MUST 用固定的 z-index 刻度,不写随意的 `z-*`
- SHOULD 正方形元素用 `size-*`,不拆 `w-*` + `h-*`
- NEVER 用渐变,除非 StyleBrief 原文点名;NEVER 紫色/多色渐变
- NEVER 把辉光当主要供能提示(affordance)
- MUST 空态给一个明确的下一步动作
- SHOULD 一个视图只用一处强调色
- SHOULD 颜色消费 theme.css 已有 token,不新造
