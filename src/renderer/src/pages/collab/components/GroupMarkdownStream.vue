<script setup lang="ts">
import { mentionsToMarkdown } from '@shared/group-mentions'
import { AppMarkdown } from '@renderer/markdown/comark'
import type { ComputedRef, InjectionKey } from 'vue'
import type { GroupRoleMeta } from '@shared/types'
import GroupMarkdownLink from './GroupMarkdownLink.vue'

const props = defineProps<{
  content: string
  members: readonly GroupRoleMeta[]
  streaming?: boolean
}>()

const groupMentionMembersKey = Symbol.for('group-mention-members') as InjectionKey<
  ComputedRef<readonly GroupRoleMeta[]>
>
provide(
  groupMentionMembersKey,
  computed(() => props.members)
)

const markdown = computed(() => mentionsToMarkdown(props.content, props.members))
const caret = computed(() => (props.streaming ? { class: 'md-caret' } : false))
const components = { a: GroupMarkdownLink }
</script>

<template>
  <div class="markdown">
    <Suspense>
      <AppMarkdown
        :markdown="markdown"
        :streaming="streaming"
        :caret="caret"
        :components="components"
      />
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
  display: block;
  overflow-x: auto;
  border-collapse: collapse;
  margin: 8px 0;
  font-size: 12px;
}

.markdown :deep(th),
.markdown :deep(td) {
  padding: 4px 8px;
  border: 1px solid var(--app-border);
  text-align: left;
}

.markdown :deep(:not(pre) > code) {
  padding: 1px 5px;
  border-radius: 5px;
  background: color-mix(in srgb, currentColor 10%, transparent);
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 0.92em;
}

.markdown :deep(pre) {
  overflow-x: auto;
  margin: 8px 0;
  padding: 10px 12px;
  border: 1px solid var(--app-border);
  border-radius: 8px;
}

.markdown :deep(pre code) {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
  line-height: 1.6;
}
</style>

<style>
html.dark .markdown .shiki,
html.dark .markdown .shiki span {
  color: var(--shiki-dark) !important;
  background-color: var(--shiki-dark-bg) !important;
  font-style: var(--shiki-dark-font-style) !important;
  font-weight: var(--shiki-dark-font-weight) !important;
  text-decoration: var(--shiki-dark-text-decoration) !important;
}

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
