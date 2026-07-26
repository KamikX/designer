<script setup lang="ts">
import { theme } from 'antdv-next'
import ToolActivityList from '../../project/components/ToolActivityList.vue'
import RoleAvatar from './RoleAvatar.vue'
import GroupMarkdownStream from './GroupMarkdownStream.vue'
import GroupMentionText from './GroupMentionText.vue'
import { useCollabStore } from '@renderer/stores/collab'
import type { ToolActivity } from '@renderer/stores/chat'
import type { Message } from '@shared/types'

/**
 * 群消息一条。和工作台的 MessageItem 长得像但不复用它:那边的核心是
 * 问答卡片 / 文件 chip / 思考流,群里一个都用不上;群里的核心——按角色
 * 取头像和名字——那边又没有。硬套会让两边都难改。
 */

const props = defineProps<{ message: Message }>()

const { token } = theme.useToken()
const collab = useCollabStore()

const isUser = computed(() => props.message.author === 'user' || props.message.role === 'user')
const role = computed(() =>
  isUser.value ? null : (collab.rolesById[props.message.author ?? ''] ?? null)
)
const streaming = computed(() => props.message.status === 'streaming')

const textContent = computed(() =>
  props.message.parts
    .filter((p) => p.type === 'text')
    .map((p) => (p.type === 'text' ? p.text : ''))
    .join('')
)

// 复用工作台的 ToolActivityList(折叠/摘要逻辑都是现成的)。它的类型多要
// 一个 toolName,群组事件不带这个字段,补空串——它只用于日志,界面不显示
const activities = computed<ToolActivity[]>(() =>
  (collab.activities[props.message.id] ?? []).map((a) => ({ ...a, toolName: '' }))
)
</script>

<template>
  <!-- 用户发言:右对齐主色气泡,和聊天页同款 -->
  <div v-if="isUser" class="gmsg gmsg--user">
    <div class="gmsg-bubble" :style="{ background: token.colorPrimary, color: '#fff' }">
      <div class="gmsg-text">
        <GroupMentionText :content="textContent" :members="collab.mentionMembers" />
      </div>
    </div>
  </div>

  <!-- 角色发言:头像 + 角色名 + markdown 文档 -->
  <div v-else class="gmsg">
    <RoleAvatar :role="role" :speaking="streaming && collab.speakingAuthor === message.author" />
    <div class="gmsg-body">
      <div class="gmsg-name" :style="{ color: role?.color ?? token.colorTextSecondary }">
        {{ role?.name ?? message.author }}
      </div>
      <div class="gmsg-bubble" :style="{ background: token.colorFillQuaternary }">
        <GroupMarkdownStream
          v-if="textContent"
          :content="textContent"
          :members="collab.mentionMembers"
          :streaming="streaming"
        />

        <ToolActivityList :activities="activities" :streaming="streaming" />

        <div v-if="streaming && !textContent" class="gmsg-typing">
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
  </div>
</template>

<style scoped>
.gmsg {
  display: flex;
  gap: 8px;
  margin-bottom: 14px;
}

.gmsg--user {
  justify-content: flex-end;
}

.gmsg-body {
  min-width: 0;
  max-width: 88%;
}

.gmsg-name {
  font-size: 12px;
  font-weight: 600;
  margin: 2px 0 4px;
}

.gmsg-bubble {
  border-radius: 14px;
  border-top-left-radius: 4px;
  padding: 9px 13px;
}

.gmsg--user .gmsg-bubble {
  max-width: 88%;
  border-top-left-radius: 14px;
  border-bottom-right-radius: 4px;
}

.gmsg-text {
  white-space: pre-wrap;
  word-break: break-word;
  font-size: 13px;
  line-height: 1.7;
}

.gmsg-typing {
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
