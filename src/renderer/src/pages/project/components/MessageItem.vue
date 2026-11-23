<script setup lang="ts">
import { t } from '@renderer/i18n'
import { theme } from 'antdv-next'
import { CheckOutlined, DeleteOutlined, FileOutlined, LineChartOutlined } from '@antdv-next/icons'
import { useChatStore } from '@renderer/stores/chat'
import MarkdownStream from '@renderer/markdown/MarkdownStream.vue'
import QuestionCard from './QuestionCard.vue'
import RunDiagnostics from './RunDiagnostics.vue'
import ToolActivityList from './ToolActivityList.vue'
import CopyButton from '@renderer/components/CopyButton.vue'
import { splitMessageStream } from '@renderer/components/message-segments'
import { isActiveToolState } from '@renderer/stores/chat'
import type { AskUserAnswer, Message } from '@shared/types'

const props = defineProps<{ message: Message }>()

const { token } = theme.useToken()
const chatStore = useChatStore()

const isUser = computed(() => props.message.role === 'user')
const streaming = computed(() => props.message.status === 'streaming')

const textContent = computed(() =>
  props.message.parts
    .filter((p) => p.type === 'text')
    .map((p) => (p.type === 'text' ? p.text : ''))
    .join('')
)

const questionParts = computed(() =>
  props.message.parts.filter(
    (p): p is Extract<Message['parts'][number], { type: 'question' }> => p.type === 'question'
  )
)

const fileParts = computed(() =>
  props.message.parts.filter(
    (p): p is Extract<Message['parts'][number], { type: 'file' }> => p.type === 'file'
  )
)

const imageParts = computed(() =>
  props.message.parts.filter(
    (p): p is Extract<Message['parts'][number], { type: 'image' }> => p.type === 'image'
  )
)

const activities = computed(() => chatStore.activities[props.message.id] ?? [])
/** 正文与工具调用按发生顺序交替,而不是把工具全堆在气泡底部 */
const segments = computed(() => splitMessageStream(textContent.value, activities.value))
const reasoning = computed(() => chatStore.reasoning[props.message.id] ?? '')
const reasoningOpen = ref(false)

const waitingOnUser = computed(
  () =>
    streaming.value && questionParts.value.some((q) => q.questionId === chatStore.pendingQuestionId)
)

/**
 * 这张卡片还等不等得到人:主进程只在流还活着时挂着那个 Promise,
 * 流一结束(完成 / 中止 / 出错)就已经按跳过放掉了。
 */
function isStale(questionId: string): boolean {
  return !streaming.value && chatStore.pendingQuestionId !== questionId
}

function answer(questionId: string, value: AskUserAnswer): void {
  void chatStore.answerQuestion(questionId, value)
}

/** 运行诊断抽屉。只给已完成的 assistant 消息;明细在打开时懒加载 */
const diagnosticsOpen = ref(false)
const canDiagnose = computed(() => !isUser.value && !streaming.value)
</script>

<template>
  <div class="message" :class="{ 'message--user': isUser }">
    <!-- 用户气泡右对齐,复制按钮摆左边;AI 的在气泡内底部(见下) -->
    <span v-if="isUser" class="message-copy">
      <CopyButton :text="textContent" :label="t('复制这条消息')" />
    </span>

    <!--
      谁说的话靠**对齐 + 填充深浅**分,不靠色相:用户在右、填充更实,AI 在左、
      填充几乎透明。之前用户气泡是整块品牌蓝,而"这条是我发的"根本不是一种
      状态——颜色在这一屏只留给生成中 / 出错 / 已写入。
    -->
    <div class="message-bubble" :class="isUser ? 'message-bubble--user' : 'message-bubble--ai'">
      <!-- 参考图缩略图:asset:// 由主进程的协议处理器直出 -->
      <div v-if="imageParts.length" class="message-images">
        <img
          v-for="img in imageParts"
          :key="img.assetId"
          :src="`asset://${img.assetId}`"
          :alt="img.name"
          :title="img.description || img.name"
          class="message-image"
        />
      </div>

      <!-- 用户消息保持纯文本:气泡是主色底,markdown 的标题/代码块在上面
           反而更难读;AI 的解说才需要结构 -->
      <div v-if="isUser && textContent" class="message-text">{{ textContent }}</div>
      <!-- AI 的解说与工具调用**按发生顺序**交替:说一句 → 调一次 → 再说一句。
           都堆在气泡底部的话,哪句话之前调了什么完全看不出来 -->
      <template v-else>
        <template v-for="(seg, index) in segments" :key="index">
          <MarkdownStream
            v-if="seg.kind === 'text'"
            :content="seg.text"
            :streaming="streaming && index === segments.length - 1"
          />
          <ToolActivityList
            v-else
            :activities="seg.activities"
            :streaming="streaming && seg.activities.some((a) => isActiveToolState(a.state))"
          />
        </template>
      </template>

      <!-- 思考流:本来就在计费,显示出来不额外花钱,但默认收起 -->
      <div v-if="reasoning" class="message-reasoning">
        <button
          type="button"
          class="message-reasoning-head"
          :style="{ color: token.colorTextTertiary }"
          @click="reasoningOpen = !reasoningOpen"
        >
          {{ reasoningOpen ? t('收起思考过程') : t('查看思考过程') }}
        </button>
        <div
          v-if="reasoningOpen"
          class="message-reasoning-body"
          :style="{ color: token.colorTextTertiary }"
        >
          {{ reasoning }}
        </div>
      </div>

      <!-- AI 的提问:主进程的工具循环正停在这里等作答 -->
      <QuestionCard
        v-for="q in questionParts"
        :key="q.questionId"
        :ask="q.ask"
        :answer="q.answer"
        :stale="isStale(q.questionId)"
        @submit="(value) => answer(q.questionId, value)"
      />

      <!--
        文件产出 chip:正文里只显示引用,内容去右侧文件树看。
        图标本身是中性的——一个文件不是一种状态;只有"删掉了"和"已写入"
        才配得上颜色,前者用错误色、后者用成功色的细勾(不是实心圆,那个
        圆点在一列三四个 chip 上排下来比文件名还抢眼)。
      -->
      <div v-if="fileParts.length" class="message-files">
        <span v-for="f in fileParts" :key="f.path + f.action" class="message-file-chip">
          <DeleteOutlined v-if="f.action === 'delete'" :style="{ color: token.colorError }" />
          <FileOutlined v-else :style="{ color: token.colorTextQuaternary }" />
          <span class="message-file-path">{{ f.path }}</span>
          <CheckOutlined
            v-if="f.action === 'write' && message.status !== 'streaming'"
            :style="{ color: token.colorSuccess, fontSize: '11px' }"
          />
        </span>
      </div>

      <!-- 等作答时不要跳打字点:那会让人以为 AI 还在写,其实是在等自己 -->
      <a-typography-text v-if="waitingOnUser" type="secondary" style="font-size: 12px">
        {{ t('等你的选择') }}
      </a-typography-text>
      <div v-else-if="message.status === 'streaming'" class="message-typing">
        <span class="typing-dot" /><span class="typing-dot" /><span class="typing-dot" />
      </div>
      <a-typography-text
        v-else-if="message.status === 'error'"
        type="danger"
        style="font-size: 12px"
      >
        {{ t('生成失败') }}
      </a-typography-text>
      <a-typography-text
        v-else-if="message.status === 'aborted'"
        type="secondary"
        style="font-size: 12px"
      >
        {{ t('已停止') }}
      </a-typography-text>

      <!-- AI 的解说复制:摆在气泡内底部,和诊断入口同一排 -->
      <span v-if="!isUser && textContent" class="message-copy message-copy--inline">
        <CopyButton :text="textContent" :label="t('复制这条回复')" />
      </span>

      <!-- 运行诊断入口:阶段耗时、工具时间线、详细 token 都在抽屉里 -->
      <button
        v-if="canDiagnose"
        type="button"
        class="message-diag-btn"
        :style="{ color: token.colorTextQuaternary }"
        :title="t('运行诊断')"
        @click="diagnosticsOpen = true"
      >
        <LineChartOutlined />
      </button>
      <RunDiagnostics
        v-if="canDiagnose && diagnosticsOpen"
        :message-id="message.id"
        :open="diagnosticsOpen"
        @close="diagnosticsOpen = false"
      />
    </div>
  </div>
</template>

<style scoped>
/*
 * 这一屏的字号只有三档,别再冒出第四档:
 *   正文 13 / 次要 12 / 附注 11。
 * 之前 14、15、13、12、11 混着用,气泡、活动条、chip 三个区块各自一套阶梯,
 * 扫下来找不到"哪一层更重要"。
 */
.message {
  display: flex;
  gap: 8px;
  /* 8 的倍数。14 是从别处抄来的孤值,和 chip 间距 4、气泡内边距 12 对不上 */
  margin-bottom: 16px;
}

.message--user {
  justify-content: flex-end;
}

/*
 * 复制按钮 hover 才现身:一屏十几条消息,常驻图标会把版面吵散。
 * 键盘焦点也要现身,否则 tab 到一个看不见的按钮上。
 */
.message-copy {
  opacity: 0;
  transition: opacity 0.15s;
  color: inherit;
}

.message-copy--inline {
  display: inline-flex;
  margin-top: 2px;
}

.message:hover .message-copy,
.message-copy:focus-within {
  opacity: 1;
}

.message--user .message-copy {
  align-self: center;
}

.message-bubble {
  max-width: 88%;
  /* 圆角取 token 里的 lg;原来的 14px 不在任何一档上,而且配上 4px 的"尖角"
     就是即时通讯软件那套气泡尾巴——左右对齐已经说明了谁在说话 */
  border-radius: var(--radius-lg);
  padding: 8px 12px;
}

/* 用户说的话是"钉在流里的指令",填充更实一档;文字用最强的那级墨色 */
.message-bubble--user {
  background: var(--bg-muted);
  color: var(--text-strong);
}

/* AI 的解说是正文,几乎不该有底——只用一层极浅的填充把它和画布分开 */
.message-bubble--ai {
  background: var(--fill-subtle);
}

.message-text {
  white-space: pre-wrap;
  word-break: break-word;
  font-size: 13px;
  line-height: 1.7;
}

.message-images {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 6px;
}

.message-image {
  max-width: 160px;
  max-height: 160px;
  border-radius: var(--radius);
  object-fit: cover;
  background: var(--fill);
}

.message-reasoning {
  margin: 6px 0;
}

.message-reasoning-head {
  border: none;
  background: none;
  padding: 0;
  cursor: pointer;
  font: inherit;
  font-size: 12px;
}

.message-reasoning-body {
  margin-top: 4px;
  padding-left: 8px;
  /* 引用竖线退成发丝级:它只是"这段是引来的"的标记,不该和正文抢边界 */
  border-left: 1px solid var(--border);
  font-size: 12px;
  line-height: 1.7;
  white-space: pre-wrap;
  max-height: 220px;
  overflow-y: auto;
  overscroll-behavior: contain;
}

.message-files {
  margin-top: 8px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.message-file-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  /* 抬起来的暖面 + 冷描边,和 tokens.css 里的表面语言一致 */
  background: var(--bg-elevated);
  border: 1px solid var(--border-soft);
  border-radius: var(--radius-sm);
  padding: 3px 9px;
  font-size: 12px;
  width: fit-content;
  max-width: 100%;
}

.message-file-path {
  font-family: var(--font-mono);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.message-diag-btn {
  border: none;
  background: none;
  padding: 2px 0 0;
  cursor: pointer;
  font-size: 12px;
  /* 平时几乎隐形,悬停气泡才浮现——诊断是回头排查用的,不该抢正文的视线 */
  opacity: 0;
  transition: opacity 0.15s;
}

.message-bubble:hover .message-diag-btn {
  opacity: 1;
}

.message-typing {
  display: flex;
  gap: 4px;
  padding: 4px 0 2px;
}

.typing-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentColor;
  opacity: 0.35;
  animation: typing-bounce 1.2s infinite;
}

.typing-dot:nth-child(2) {
  animation-delay: 0.15s;
}

.typing-dot:nth-child(3) {
  animation-delay: 0.3s;
}

@keyframes typing-bounce {
  0%,
  60%,
  100% {
    transform: translateY(0);
    opacity: 0.35;
  }
  30% {
    transform: translateY(-3px);
    opacity: 0.9;
  }
}
</style>
