<script setup lang="ts">
import { theme } from 'antdv-next'
import { CheckCircleFilled, DeleteOutlined, FileOutlined } from '@antdv-next/icons'
import { useChatStore } from '@renderer/stores/chat'
import MarkdownStream from '@renderer/markdown/MarkdownStream.vue'
import QuestionCard from './QuestionCard.vue'
import ToolActivityList from './ToolActivityList.vue'
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
</script>

<template>
  <div class="message" :class="{ 'message--user': isUser }">
    <!-- AI 头像:渐变小方块,让对话流有呼吸感;用户消息不放头像 -->
    <div v-if="!isUser" class="message-avatar">✦</div>

    <div
      class="message-bubble"
      :style="
        isUser
          ? { background: token.colorPrimary, color: '#fff' }
          : { background: token.colorFillQuaternary }
      "
    >
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
      <MarkdownStream v-else-if="textContent" :content="textContent" :streaming="streaming" />

      <!-- 思考流:本来就在计费,显示出来不额外花钱,但默认收起 -->
      <div v-if="reasoning" class="message-reasoning">
        <button
          type="button"
          class="message-reasoning-head"
          :style="{ color: token.colorTextTertiary }"
          @click="reasoningOpen = !reasoningOpen"
        >
          {{ reasoningOpen ? '收起思考过程' : '查看思考过程' }}
        </button>
        <div
          v-if="reasoningOpen"
          class="message-reasoning-body"
          :style="{ color: token.colorTextTertiary }"
        >
          {{ reasoning }}
        </div>
      </div>

      <!-- 工具活动:没有它,调工具的那几十秒聊天框就是死的 -->
      <ToolActivityList :activities="activities" :streaming="streaming" />

      <!-- AI 的提问:主进程的工具循环正停在这里等作答 -->
      <QuestionCard
        v-for="q in questionParts"
        :key="q.questionId"
        :ask="q.ask"
        :answer="q.answer"
        :stale="isStale(q.questionId)"
        @submit="(value) => answer(q.questionId, value)"
      />

      <!-- 文件产出 chip:正文里只显示引用,内容去右侧文件树看 -->
      <div v-if="fileParts.length" class="message-files">
        <span
          v-for="f in fileParts"
          :key="f.path + f.action"
          class="message-file-chip"
          :style="{ background: token.colorBgContainer, borderColor: token.colorBorderSecondary }"
        >
          <DeleteOutlined v-if="f.action === 'delete'" style="color: var(--ant-color-error)" />
          <FileOutlined v-else :style="{ color: token.colorPrimary }" />
          <span class="message-file-path">{{ f.path }}</span>
          <CheckCircleFilled
            v-if="f.action === 'write' && message.status !== 'streaming'"
            :style="{ color: token.colorSuccess, fontSize: '11px' }"
          />
        </span>
      </div>

      <!-- 等作答时不要跳打字点:那会让人以为 AI 还在写,其实是在等自己 -->
      <a-typography-text v-if="waitingOnUser" type="secondary" style="font-size: 12px">
        等你的选择
      </a-typography-text>
      <div v-else-if="message.status === 'streaming'" class="message-typing">
        <span class="typing-dot" /><span class="typing-dot" /><span class="typing-dot" />
      </div>
      <a-typography-text
        v-else-if="message.status === 'error'"
        type="danger"
        style="font-size: 12px"
      >
        生成失败
      </a-typography-text>
      <a-typography-text
        v-else-if="message.status === 'aborted'"
        type="secondary"
        style="font-size: 12px"
      >
        已停止
      </a-typography-text>
    </div>
  </div>
</template>

<style scoped>
.message {
  display: flex;
  gap: 8px;
  margin-bottom: 14px;
}

.message--user {
  justify-content: flex-end;
}

.message-avatar {
  width: 26px;
  height: 26px;
  border-radius: 9px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 13px;
  color: #fff;
  background: linear-gradient(135deg, #6a8dff, #9b6aff);
  margin-top: 2px;
}

.message-bubble {
  max-width: 88%;
  border-radius: 14px;
  padding: 9px 13px;
}

.message--user .message-bubble {
  border-bottom-right-radius: 4px;
}

.message:not(.message--user) .message-bubble {
  border-top-left-radius: 4px;
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
  border-radius: 8px;
  object-fit: cover;
  background: rgba(128, 128, 128, 0.12);
}

.message-reasoning {
  margin: 4px 0;
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
  border-left: 1px solid var(--app-border);
  font-size: 12px;
  line-height: 1.7;
  white-space: pre-wrap;
  max-height: 220px;
  overflow-y: auto;
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
  border: 1px solid transparent;
  border-radius: 8px;
  padding: 4px 10px;
  font-size: 12px;
  width: fit-content;
  max-width: 100%;
}

.message-file-path {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
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
