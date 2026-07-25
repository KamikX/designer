# 版面库

**别从零写区块。挑最接近的一个,粘贴,换文案。**

每个版面都标了什么时候**不该**用它——那部分和标记本身一样重要。

---

## 1. 首屏 · 左对齐

用于:落地页、产品页。默认选它,不是居中版。

```html
<section class="section">
  <div class="container">
    <p class="eyebrow">面向工程团队</p>
    <h1>把评审留在写代码的地方</h1>
    <p class="lead mt-6">
      不必在编辑器和网页之间来回切。评论、建议、批准都在同一处完成。
    </p>
    <div class="mt-10 flex gap-3">
      <a class="btn btn-primary">开始使用</a>
      <a class="btn btn-ghost">看演示</a>
    </div>
  </div>
</section>
```

**不要**在深色大图上放居中的 h1 —— 那是最常见的模板长相。

---

## 2. 首屏 · 居中

用于:内容型、文档首页、单一主张的页面。

一屏之内只留**一个**行动号召。居中布局本身已经很强势,再放两个按钮就散了。

---

## 3. 三栏特性

```html
<section class="section">
  <div class="container grid grid-cols-3 gap-8">
    <div>
      <svg class="w-6 h-6 text-ink-muted" fill="none" stroke="currentColor" stroke-width="1.7">…</svg>
      <h3 class="mt-4">增量同步</h3>
      <p class="mt-2 text-ink-muted">只传改动的那部分,不是整棵树。</p>
    </div>
    …
  </div>
</section>
```

- 图标用 **1.6–1.8px 描边的单线 SVG**,`stroke="currentColor"`
- **不要用 emoji 当图标**
- 三栏是上限。四栏开始像宣传册

---

## 4. 数据条

**有真实数字时才用。**

```html
<div class="grid grid-cols-3 gap-px bg-line">
  <div class="bg-surface p-8">
    <div class="num text-4xl">38<span class="text-ink-muted text-2xl">×</span></div>
    <p class="mt-2 text-meta text-ink-muted">在真实负载下,比朴素同步少传的数据量。</p>
  </div>
  …
</div>
```

注意 `gap-px` + 子项自己的背景 —— **缝隙本身就是分隔线**,不用画边框。

**最多三个。不要编数字。** 没有真实数字就换一个版面。

---

## 5. 引言

一句有分量的话 + 署名。**一页一个,绝不连着放两个。**

---

## 6. 行动号召

页面末尾。一句话 + 一个按钮。不要在这里再塞特性列表。

---

## 7. 日志列表

用于:更新记录、文章列表、版本历史。

左边等宽日期,中间标题 + 摘要,右边可选的数字。

**分隔线只画在顶部,不要画成框** —— 框会让内容读起来像宣传册。

---

## 8. 对比表

用于:定价、方案选择。

- 表头固定,数字右对齐、等宽
- 推荐档用**边框**标记,不要用大色块填充
- 行之间用发丝线,不要斑马纹

---

## 可用的类

`section` `container` `eyebrow` `lead` `num` `card` `btn` `btn-primary`
`btn-ghost` `ph-img` `callout`

用到这个清单以外的类,先在 `theme.css` 的 `@layer components` 里定义,
或者用行内 `style`。**不要在 `<section>` 上写一个没有 CSS 支撑的全局类名。**
