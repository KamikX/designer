---
name: design-seed
description: 新项目的主题生成方法与质量护栏。Use when 第一次产出设计稿、需要生成项目自己的 theme.css，或需要把已确认的 StyleBrief 转换为一致且可访问的设计系统时。
metadata:
  scope: foundation
---

# 设计种子

When project guidance includes DESIGN.md, references to StyleBrief in this skill mean the combined
Visual style and DESIGN.md rules under the project's selected source priority. This affects visual
choices only; skill activation, workflows, technical contracts and accessibility still apply.

## 先判读项目方向

1. **先读项目 StyleBrief。** 非空 StyleBrief 是最高优先级：它决定字体体系、明暗与
   色温、字号与行高、密度与间距、圆角与几何、边框/阴影/表面、按钮与卡片，以及动效。
2. StyleBrief 为空时，遵守项目 prompt 的首次风格确认流程；用户显式跳过才使用 prompt
   提供的 fallback。不要擅自回落到固定颜色、字体、字号、间距、圆角、按钮或卡片样式。
3. 将判读浓缩成一句可核对的话，说明主题方向和会影响全局的取舍；它是执行记录，不是
   用模板替用户做决定。

StyleBrief 高于本文任何示例。design-seed 不提供可复制的成品视觉；它只约束语义 token、
跨页面一致性、对比度、状态覆盖和可访问性。

## 生成项目自己的完整 theme.css

为当前项目从零生成**完整 `theme.css`**，把已确认方向落实为可复用的 token、基础样式和
组件状态。创建文件时才按需阅读 `references/theme-contract.md`，确保接口完整；不要把它
误当成视觉默认值。

- 字体、字阶、行高、间距尺度、容器、圆角、边框、阴影、表面和动效都必须相互呼应，且
  可从 StyleBrief 追溯。
- 建立品牌、背景、文本、边界、交互、状态和焦点 token；按钮、卡片、输入、表格、导航
  与弹层消费同一套语义。
- 为悬停、聚焦、禁用、加载、空、错误和成功状态提供清晰反馈；不能只靠颜色传递状态。
- 文字/背景、边界/表面、焦点环/周围内容必须有足够对比度，并处理减少动态偏好。

## 先展示体系，再扩展页面

The specification-page workflow below applies to page targets. For `components` projects, follow
`target-components` for the preview deliverable instead; do not create a separate design-system
page or view. Theme generation and semantic token requirements above still apply.

## 第一个页面画设计体系本身

token 定完之后,**先画一个可预览的规范页**(html 栈叫 `design-system.html`,
vue3/react 就是一个可切换的视图),而不是直接做业务页。

用户要能**看见**你定了什么,而不是去代码里翻 CSS 变量。这一页包含:

- 色板:每组一行,色块 + token 名 + 色值
- 字号阶梯:每级用真实文案示范
- 圆角与阴影:各档位摆出实物方块
- 基础组件:按钮(主/次 × 默认/悬停/禁用)、输入框、卡片、标签、空态

这一页同时是给用户的"设计交底",也是你后续所有页面的取样板。

## 收尾:五维自评

写完之后按 1–5 分默默给自己打分:

1. **气质** —— 视觉姿态是否符合要求?还是又退回了你最顺手的那套默认?
2. **层级** —— 一屏之内视线是否有一个明确的落点?
3. **执行** —— 排版、间距、对齐、对比是"对"还是只是"接近"?
4. **具体性** —— 每个字、每个数、每张图是否只属于**这一份**需求?
5. **一致性** —— token、组件状态与各页面是否表达同一份已确认的设计方向?

**任何一维低于 3 分都算退步。回去改最弱的那一维,重新打分。两轮是正常的。**
