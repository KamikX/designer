<script setup lang="ts">
import { AppMarkdown } from './comark'

/**
 * 流式 markdown 渲染。设计稿对话和将来的通用 chat 共用这一个组件,
 * 所以它不认识 Message、不认识任何业务类型,只吃字符串。
 *
 * `<Comark>` 是异步组件(要等 shiki 加载语法),必须包 Suspense。
 * fallback 直接把原文按 pre-wrap 显示——首帧不至于空白,而且退化态
 * 就是我们接 comark 之前的样子。
 */

const props = defineProps<{
  content: string
  /** 流式进行中:开 auto-close 和光标 */
  streaming?: boolean
}>()

// caret 由 comark 挂内联样式(含 animation: pulse),我们只补一个 class
// 方便调整尺寸,并在全局样式里补上 pulse 关键帧
const caret = computed(() => (props.streaming ? { class: 'md-caret' } : false))
</script>

<template>
  <div class="markdown">
    <Suspense>
      <AppMarkdown :markdown="content" :streaming="streaming" :caret="caret" />
      <template #fallback>
        <div class="markdown-fallback">{{ content }}</div>
      </template>
    </Suspense>
  </div>
</template>

<style scoped>
.markdown {
  font-size: 13px;
  line-height: 1.75;
  word-break: break-word;
}

.markdown-fallback {
  white-space: pre-wrap;
}

.markdown :deep(> *:first-child) {
  margin-top: 0;
}

.markdown :deep(> *:last-child) {
  margin-bottom: 0;
}

.markdown :deep(p) {
  margin: 0 0 8px;
}

.markdown :deep(h1),
.markdown :deep(h2),
.markdown :deep(h3),
.markdown :deep(h4) {
  margin: 14px 0 6px;
  font-size: 14px;
  font-weight: 600;
  line-height: 1.5;
}

.markdown :deep(ul),
.markdown :deep(ol) {
  margin: 0 0 8px;
  padding-left: 20px;
}

.markdown :deep(li) {
  margin: 2px 0;
}

.markdown :deep(blockquote) {
  margin: 8px 0;
  padding-left: 10px;
  border-left: 2px solid var(--app-border);
  opacity: 0.8;
}

.markdown :deep(a) {
  color: var(--app-primary);
}

.markdown :deep(hr) {
  margin: 12px 0;
  border: none;
  border-top: 1px solid var(--app-border);
}

.markdown :deep(table) {
  border-collapse: collapse;
  margin: 8px 0;
  font-size: 12px;
  display: block;
  overflow-x: auto;
}

.markdown :deep(th),
.markdown :deep(td) {
  border: 1px solid var(--app-border);
  padding: 4px 8px;
  text-align: left;
}

/* 行内代码 */
.markdown :deep(:not(pre) > code) {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 0.92em;
  padding: 1px 5px;
  border-radius: 5px;
  background: color-mix(in srgb, currentColor 10%, transparent);
}

/* 代码块:横向自己滚,绝不把气泡撑宽。底色由 shiki 的 preStyles 给 */
.markdown :deep(pre) {
  margin: 8px 0;
  padding: 10px 12px;
  border-radius: 8px;
  overflow-x: auto;
  border: 1px solid var(--app-border);
}

.markdown :deep(pre code) {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
  line-height: 1.6;
}
</style>

<style>
/*
 * shiki 双主题:亮色走内联样式,暗色放在 --shiki-dark* 变量里,靠这条
 * 规则切换。选择器不能 scoped——高亮的 span 是 comark 渲染出来的,
 * 带不上 scope 属性。
 */
html.dark .markdown .shiki,
html.dark .markdown .shiki span {
  color: var(--shiki-dark) !important;
  background-color: var(--shiki-dark-bg) !important;
  font-style: var(--shiki-dark-font-style) !important;
  font-weight: var(--shiki-dark-font-weight) !important;
  text-decoration: var(--shiki-dark-text-decoration) !important;
}

/*
 * comark 的流式光标内联了 `animation: pulse ...`,但那条关键帧要靠
 * 宿主提供(它假设有 Tailwind)。自己补一份,免得依赖 Tailwind 是否
 * 正好产出了 pulse。
 */
@keyframes pulse {
  50% {
    opacity: 0.25;
  }
}

.markdown .md-caret {
  width: 2px;
  border-radius: 1px;
}
</style>
