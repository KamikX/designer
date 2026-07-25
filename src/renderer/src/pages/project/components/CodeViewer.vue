<script setup lang="ts">
import { theme } from 'antdv-next'
import { useArtifactStore } from '@renderer/stores/artifact'

/**
 * 代码查看器。一期用 pre + 等宽字体,语法高亮不进主链路。
 * 流式期间内容持续增长,自动贴底滚动,观感即"打字机写代码"。
 */

const { token } = theme.useToken()
const store = useArtifactStore()
const el = ref<HTMLElement | null>(null)

watch(
  () => store.selectedContent,
  () => {
    if (!store.streamingFiles) return
    nextTick(() => el.value?.scrollTo({ top: el.value.scrollHeight }))
  }
)
</script>

<template>
  <div
    ref="el"
    class="code-viewer"
    :style="{ background: token.colorFillQuaternary, borderColor: token.colorBorderSecondary }"
  >
    <pre v-if="store.selectedContent">{{ store.selectedContent }}</pre>
    <a-empty v-else description="选择左侧文件查看内容" style="margin-top: 60px" />
  </div>
</template>

<style scoped>
.code-viewer {
  height: 100%;
  overflow: auto;
  border: 1px solid transparent;
  border-radius: 6px;
  padding: 10px 12px;
}

.code-viewer pre {
  margin: 0;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-all;
}
</style>
