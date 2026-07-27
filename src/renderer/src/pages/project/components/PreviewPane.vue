<script setup lang="ts">
import { theme } from 'antdv-next'
import { HighlightOutlined, ReloadOutlined } from '@antdv-next/icons'
import { useArtifactStore } from '@renderer/stores/artifact'
import { MAX_MARKS, useAnnotationStore } from '@renderer/stores/annotation'
import type { MarkTarget } from '@renderer/stores/annotation'

/**
 * 预览面板。iframe 指向 preview://artifact/<id>/,主进程从 DB 直出文件。
 * 引导页把编译/运行错误 postMessage 上来,显示成错误条,不让用户对着白屏猜。
 *
 * 错误除了显示给用户,还**上报主进程**:下一轮组装 prompt 时会带给模型。
 * 在这之前模型写完代码就没有任何反馈了——它不知道自己生成的东西跑不跑得
 * 起来,得等用户手动把报错粘回对话里。这是整条链路上唯一没闭合的环。
 *
 * 标注是同一条链路的另一半:iframe 里点中的元素 + 用户的备注,随下一条消息
 * 交给模型(见 stores/annotation.ts)。iframe 是另一个源,这边读不到它的 DOM,
 * 所有拾取与徽标都在 preview/annotate-runtime.ts 里,这里只负责收发和输入。
 */

const { token } = theme.useToken()
const store = useArtifactStore()
const annotation = useAnnotationStore()

const reloadKey = ref(0)
const runtimeError = ref('')
const loading = ref(false)
const frame = ref<HTMLIFrameElement | null>(null)

const src = computed(() => (store.currentId ? `preview://artifact/${store.currentId}/` : ''))

/* ---------------- 标注 ---------------- */

/** 拾取到、还没写备注的元素。有值时备注弹窗打开 */
const picked = ref<MarkTarget | null>(null)
const note = ref('')

function post(message: Record<string, unknown>): void {
  frame.value?.contentWindow?.postMessage(message, '*')
}

function toggleAnnotate(): void {
  annotation.enabled = !annotation.enabled
  post({ __previewCmd: 'annotate', on: annotation.enabled })
}

/** 徽标画在 iframe 里,所以每次增删都要把整份清单同步过去 */
function syncMarks(): void {
  post({
    __previewCmd: 'annotate:sync',
    marks: annotation.marks.map((m) => ({ id: m.id, index: m.index, selector: m.target.selector }))
  })
}

watch(() => annotation.marks.length, syncMarks)

function confirmNote(): void {
  if (!picked.value) return
  const added = annotation.add(picked.value, note.value)
  picked.value = null
  note.value = ''
  if (!added) return
  syncMarks()
}

function cancelNote(): void {
  picked.value = null
  note.value = ''
}

/** 元素签名的一句话摘要,备注弹窗和输入框 chips 共用同一套口径 */
function markLabel(target: MarkTarget): string {
  const text = target.text ? `「${target.text.slice(0, 14)}」` : ''
  const cls = !text && target.classes.length ? `.${target.classes[0]}` : ''
  return `${target.tag}${text}${cls}`
}

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

// 版本切换 / 新版本生成:重新走一遍加载态。标记绑在版本上,一起作废
watch(
  src,
  (next) => {
    annotation.syncArtifact(store.currentId)
    next ? beginLoad() : endLoad()
  },
  { immediate: true }
)

function refresh(): void {
  reloadKey.value++
  beginLoad()
}

// 依赖包这类"不改文件但改装配"的设置变了,引导 HTML 要重新生成——强刷
watch(
  () => store.previewEpoch,
  () => refresh()
)

function onMessage(e: MessageEvent): void {
  if (!e.data?.__preview) return
  // 标注消息带元素签名,来源要认准是我们这个 iframe
  const fromFrame = e.source === frame.value?.contentWindow

  if (e.data.type === 'ready') {
    endLoad()
    // iframe 重载后运行时是全新的:标注态和已有徽标都得重新告诉它一遍
    if (fromFrame) {
      post({ __previewCmd: 'annotate', on: annotation.enabled })
      syncMarks()
    }
    return
  }
  if (e.data.type === 'annotate:pick') {
    if (!fromFrame) return
    if (annotation.marks.length >= MAX_MARKS) return
    picked.value = e.data.target as MarkTarget
    note.value = ''
    return
  }
  if (e.data.type === 'annotate:cancel') {
    // iframe 里按了 Esc
    if (fromFrame) annotation.enabled = false
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

    <div
      class="preview-frame"
      :style="{ borderColor: token.colorBorderSecondary, background: token.colorBgContainer }"
    >
      <iframe
        v-if="src"
        :key="`${src}-${reloadKey}`"
        ref="frame"
        :src="src"
        sandbox="allow-scripts allow-same-origin"
        class="preview-iframe"
      />
      <a-empty v-else description="暂无可预览的版本" style="margin-top: 120px" />

      <!-- 骨架屏盖在 iframe 上,而不是替换它:iframe 得先挂载才能开始加载。
           照着页面的样子摆(顶栏 / 侧栏 / 卡片),比一个居中转圈更能说明
           "马上出现的是一个页面" -->
      <div
        v-if="loading && src"
        class="preview-skeleton"
        :style="{
          background: token.colorBgContainer,
          '--sk-base': token.colorFillSecondary,
          '--sk-highlight': token.colorFillTertiary
        }"
      >
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

    <div v-if="src" class="preview-actions">
      <!-- 标注态是一种"模式",按钮要一直亮着提示它开着,不然用户会以为页面点不动了 -->
      <a-tooltip :title="annotation.enabled ? '退出标注(或按 Esc)' : '标注要改的元素'">
        <a-button
          size="small"
          shape="circle"
          :type="annotation.enabled ? 'primary' : 'default'"
          @click="toggleAnnotate"
        >
          <template #icon><HighlightOutlined /></template>
        </a-button>
      </a-tooltip>
      <a-tooltip title="刷新预览">
        <a-button size="small" shape="circle" @click="refresh">
          <template #icon><ReloadOutlined /></template>
        </a-button>
      </a-tooltip>
    </div>

    <div v-if="annotation.enabled" class="preview-tip" :style="{ background: token.colorPrimary }">
      点页面上任意元素做标记,写一句想怎么改;标记会随下一条消息给 AI
    </div>

    <a-modal
      :open="!!picked"
      title="标记这处元素"
      ok-text="加入标记"
      cancel-text="取消"
      :width="440"
      @ok="confirmNote"
      @cancel="cancelNote"
    >
      <div v-if="picked" class="mark-form">
        <div class="mark-el" :style="{ color: token.colorTextSecondary }">
          <a-tag color="blue">{{ markLabel(picked) }}</a-tag>
          <span v-if="picked.source" class="mark-src">{{ picked.source }}</span>
        </div>
        <a-textarea
          v-model:value="note"
          :auto-size="{ minRows: 3, maxRows: 6 }"
          placeholder="这里想改成什么?例如:按钮太小了,改成主色大号"
          @press-enter.meta="confirmNote"
        />
      </div>
    </a-modal>
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

/*
 * 容器跟随主题;**纸白挪到 iframe 上**(见下)。
 *
 * 这两层要分开:容器上出现的是我们自己的东西(空态、骨架屏),它们该跟着应用
 * 的明暗走;而 iframe 里是用户的设计稿,那是另一套主题。之前两者共用一个写死
 * 的 #fff,暗色模式下就是一大块刺眼的白。
 */
.preview-frame {
  flex: 1;
  min-height: 0;
  border: 1px solid transparent;
  border-radius: 6px;
  overflow: hidden;
}

/*
 * 纸白给 iframe 自己,**不要跟着暗色模式变**。
 *
 * 用户的浅色设计稿如果没给 body 设背景,文档背景就是透明的,全靠这层白底撑着。
 * 跟着应用主题变暗的话,浅色设计会变成深底配深字——直接不可读。
 *
 * 设计稿的明暗是设计稿自己的事,和应用界面的明暗无关。
 */
.preview-iframe {
  width: 100%;
  height: 100%;
  background: #fff;
  border: 0;
  display: block;
}

.preview-actions {
  position: absolute;
  right: 10px;
  top: 10px;
  display: flex;
  gap: 6px;
}

/* 标注态的说明条:贴底居中,不挡住页面顶部——那儿通常是导航,标注的高频目标 */
.preview-tip {
  position: absolute;
  left: 50%;
  bottom: 12px;
  transform: translateX(-50%);
  padding: 5px 12px;
  border-radius: 999px;
  color: #fff;
  font-size: 12px;
  white-space: nowrap;
  pointer-events: none;
  box-shadow: 0 2px 8px rgb(0 0 0 / 20%);
}

.mark-form {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.mark-el {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
}

.mark-src {
  font-family: var(--mono-font, monospace);
}

/* ---------------- 骨架屏 ---------------- */

.preview-skeleton {
  position: absolute;
  inset: 0;
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
  /* 色值由外层按主题注入:写死的浅灰在暗色下是三条亮带,比没有骨架屏还显眼 */
  background: linear-gradient(
    90deg,
    var(--sk-base) 25%,
    var(--sk-highlight) 37%,
    var(--sk-base) 63%
  );
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
