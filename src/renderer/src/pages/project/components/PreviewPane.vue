<script setup lang="ts">
import { theme } from 'antdv-next'
import { ReloadOutlined } from '@antdv-next/icons'
import { useArtifactStore } from '@renderer/stores/artifact'

/**
 * 预览面板。iframe 指向 preview://artifact/<id>/,主进程从 DB 直出文件。
 * 引导页把编译/运行错误 postMessage 上来,显示成错误条,不让用户对着白屏猜。
 *
 * 错误除了显示给用户,还**上报主进程**:下一轮组装 prompt 时会带给模型。
 * 在这之前模型写完代码就没有任何反馈了——它不知道自己生成的东西跑不跑得
 * 起来,得等用户手动把报错粘回对话里。这是整条链路上唯一没闭合的环。
 */

const { token } = theme.useToken()
const store = useArtifactStore()

const reloadKey = ref(0)
const runtimeError = ref('')
const loading = ref(false)

const src = computed(() => (store.currentId ? `preview://artifact/${store.currentId}/` : ''))

/**
 * 兜底时限。
 *
 * 正常情况由 iframe 里的 ready 消息撤掉骨架屏,但那条消息可能永远不来:
 * 版本文件缺失导致脚本没跑起来、编译卡死、或者哪天引导页被改坏了。
 * 骨架屏一直转比白屏更糟——它在暗示"再等等就好了"。到点就撤,让用户
 * 看见真实情况(哪怕是白的),自己按刷新。
 */
const READY_TIMEOUT_MS = 10_000
let timer: ReturnType<typeof setTimeout> | undefined

function beginLoad(): void {
  runtimeError.value = ''
  loading.value = true
  clearTimeout(timer)
  timer = setTimeout(() => (loading.value = false), READY_TIMEOUT_MS)
}

function endLoad(): void {
  loading.value = false
  clearTimeout(timer)
}

// 版本切换 / 新版本生成:重新走一遍加载态
watch(src, (next) => (next ? beginLoad() : endLoad()), { immediate: true })

function refresh(): void {
  reloadKey.value++
  beginLoad()
}

function onMessage(e: MessageEvent): void {
  if (!e.data?.__preview) return

  if (e.data.type === 'ready') {
    endLoad()
    return
  }
  if (e.data.type !== 'error') return

  // 报错了就别再挂着骨架屏:错误条才是此刻该看的东西
  endLoad()
  const message = String(e.data.message)
  runtimeError.value = message
  // 带上出错时的版本号:用户切回旧版本看到的报错,不该让模型去改新版本
  if (store.projectId && store.currentId) {
    void window.api.preview.reportError(store.projectId, store.currentId, message)
  }
}

onMounted(() => window.addEventListener('message', onMessage))
onBeforeUnmount(() => {
  window.removeEventListener('message', onMessage)
  clearTimeout(timer)
})
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

      <!-- 骨架屏盖在 iframe 上,而不是替换它:iframe 得先挂载才能开始加载。
           照着页面的样子摆(顶栏 / 侧栏 / 卡片),比一个居中转圈更能说明
           "马上出现的是一个页面" -->
      <div v-if="loading && src" class="preview-skeleton">
        <div class="sk-topbar">
          <span class="sk sk-dot" />
          <span class="sk sk-line" style="width: 120px" />
          <span class="sk sk-line" style="width: 64px; margin-left: auto" />
        </div>
        <div class="sk-body">
          <div class="sk-side">
            <span v-for="i in 5" :key="i" class="sk sk-line" :style="{ width: `${88 - i * 8}%` }" />
          </div>
          <div class="sk-main">
            <div class="sk-cards">
              <span v-for="i in 3" :key="i" class="sk sk-card" />
            </div>
            <span class="sk sk-block" />
          </div>
        </div>
      </div>
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

/* ---------------- 骨架屏 ---------------- */

.preview-skeleton {
  position: absolute;
  inset: 0;
  background: #fff;
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 16px;
  /* 刷新按钮要压在它上面,否则加载中点不到 */
  z-index: 1;
}

.sk-topbar {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-shrink: 0;
}

.sk-body {
  flex: 1;
  min-height: 0;
  display: flex;
  gap: 16px;
}

.sk-side {
  width: 140px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.sk-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.sk-cards {
  display: flex;
  gap: 16px;
}

/*
 * 用背景位移做微光,不用 opacity 闪烁:整块忽明忽暗很吵,而预览区是整个
 * 界面里最大的一块,闪起来很难忽略。
 */
.sk {
  border-radius: 6px;
  background: linear-gradient(90deg, #f0f0f0 25%, #f7f7f7 37%, #f0f0f0 63%);
  background-size: 400% 100%;
  animation: sk-shimmer 1.4s ease-in-out infinite;
}

.sk-dot {
  width: 22px;
  height: 22px;
  border-radius: 50%;
  flex-shrink: 0;
}

.sk-line {
  height: 12px;
}

.sk-card {
  flex: 1;
  height: 88px;
}

.sk-block {
  flex: 1;
  min-height: 0;
}

@keyframes sk-shimmer {
  0% {
    background-position: 100% 50%;
  }
  100% {
    background-position: 0 50%;
  }
}

/* 用户开了"减少动态效果"就别晃:这类动画是前庭不适的常见触发源 */
@media (prefers-reduced-motion: reduce) {
  .sk {
    animation: none;
  }
}
</style>
