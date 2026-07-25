<script setup lang="ts">
import { theme } from 'antdv-next'
import { CheckCircleFilled, DeleteOutlined, FileOutlined } from '@antdv-next/icons'
import type { Message } from '@shared/types'

const props = defineProps<{ message: Message }>()

const { token } = theme.useToken()

const isUser = computed(() => props.message.role === 'user')

const textContent = computed(() =>
  props.message.parts
    .filter((p) => p.type === 'text')
    .map((p) => (p.type === 'text' ? p.text : ''))
    .join('')
)

const fileParts = computed(() =>
  props.message.parts.filter(
    (p): p is Extract<Message['parts'][number], { type: 'file' }> => p.type === 'file'
  )
)
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
      <div v-if="textContent" class="message-text">{{ textContent }}</div>

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

      <div v-if="message.status === 'streaming'" class="message-typing">
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
