<script setup lang="ts">
import { theme } from 'antdv-next'
import { ReloadOutlined } from '@antdv-next/icons'
import { useArtifactStore } from '@renderer/stores/artifact'

/**
 * 预览面板。iframe 指向 preview://artifact/<id>/,主进程从 DB 直出文件。
 * 引导页把编译/运行错误 postMessage 上来,显示成错误条,不让用户对着白屏猜。
 */

const { token } = theme.useToken()
const store = useArtifactStore()

const reloadKey = ref(0)
const runtimeError = ref('')

const src = computed(() => (store.currentId ? `preview://artifact/${store.currentId}/` : ''))

// 版本切换 / 新版本生成时清掉旧错误
watch(src, () => {
  runtimeError.value = ''
})

function refresh(): void {
  runtimeError.value = ''
  reloadKey.value++
}

function onMessage(e: MessageEvent): void {
  if (e.data?.__preview && e.data.type === 'error') {
    runtimeError.value = String(e.data.message)
  }
}

onMounted(() => window.addEventListener('message', onMessage))
onBeforeUnmount(() => window.removeEventListener('message', onMessage))
</script>

<template>
  <div class="preview-pane">
    <a-alert
      v-if="runtimeError"
      type="error"
      show-icon
      closable
      message="预览运行出错"
      class="preview-error"
      @close="runtimeError = ''"
    >
      <template #description>
        <pre class="preview-error-detail">{{ runtimeError }}</pre>
      </template>
    </a-alert>

    <div class="preview-frame" :style="{ borderColor: token.colorBorderSecondary }">
      <iframe
        v-if="src"
        :key="`${src}-${reloadKey}`"
        :src="src"
        sandbox="allow-scripts allow-same-origin"
        class="preview-iframe"
      />
      <a-empty v-else description="暂无可预览的版本" style="margin-top: 120px" />
    </div>

    <a-button v-if="src" class="preview-refresh" size="small" shape="circle" @click="refresh">
      <template #icon><ReloadOutlined /></template>
    </a-button>
  </div>
</template>

<style scoped>
.preview-pane {
  position: relative;
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.preview-error {
  flex-shrink: 0;
  margin-bottom: 8px;
}

.preview-error-detail {
  margin: 0;
  max-height: 120px;
  overflow: auto;
  font-size: 11px;
  white-space: pre-wrap;
}

.preview-frame {
  flex: 1;
  min-height: 0;
  border: 1px solid transparent;
  border-radius: 6px;
  overflow: hidden;
  /* 预览内容背景不透明:设计稿要在"纸"上看,不能透出毛玻璃 */
  background: #fff;
}

.preview-iframe {
  width: 100%;
  height: 100%;
  border: 0;
  display: block;
}

.preview-refresh {
  position: absolute;
  right: 10px;
  top: 10px;
}
</style>
