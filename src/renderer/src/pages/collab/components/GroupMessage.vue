<script setup lang="ts">
import { t } from '@renderer/i18n'
import { theme } from 'antdv-next'
import ToolActivityList from '../../project/components/ToolActivityList.vue'
import RoleAvatar from './RoleAvatar.vue'
import GroupMarkdownStream from './GroupMarkdownStream.vue'
import GroupMentionText from './GroupMentionText.vue'
import CopyButton from '@renderer/components/CopyButton.vue'
import { splitMessageStream } from '@renderer/components/message-segments'
import { isActiveToolState } from '@renderer/stores/chat'
import { mentionsToModelText } from '@shared/group-mentions'
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

/**
 * 复制出去的原文。
 *
 * **必须先把结构化提及转成 `@名字`**:库里存的是 `@[架构师](member:01ARZ...)`,
 * 界面上显示的是「@架构师」。直接复制正文,用户粘到别处就是一串 ULID——
 * 他要的是能存档的文档,不是我们的内部标识。
 */
const copyText = computed(() => mentionsToModelText(textContent.value, collab.mentionMembers))

// 复用工作台的 ToolActivityList(折叠/摘要逻辑都是现成的)。它的类型多要
// 一个 toolName,群组事件不带这个字段,补空串——它只用于日志,界面不显示
const activities = computed<ToolActivity[]>(() =>
  (collab.activities[props.message.id] ?? []).map((a) => ({ ...a, toolName: '' }))
)

/** 正文与工具调用按发生顺序交替,而不是把工具全堆在气泡底部 */
const segments = computed(() => splitMessageStream(textContent.value, activities.value))
</script>

<template>
  <!-- 用户发言:右对齐主色气泡,和聊天页同款 -->
  <div v-if="isUser" class="gmsg gmsg--user">
    <span class="gmsg-copy"
      ><CopyButton :text="copyText" :label="t('common.copyThisMessage')"
    /></span>
    <div class="gmsg-bubble" :style="{ background: token.colorPrimary, color: '#fff' }">
      <div class="gmsg-text">
        <GroupMentionText :content="textContent" :members="collab.mentionMembers" />
      </div>
    </div>
  </div>

  <!-- 角色发言:头像 + 角色名 + markdown 文档 -->
  <div v-else class="gmsg">
    <!-- 按这条消息判,不看"谁最后开始说话":并行时那不是同一个人 -->
    <RoleAvatar
      :role="role"
      :speaking="streaming && collab.speakingByMessage[message.id] === message.author"
    />
    <div class="gmsg-body">
      <div class="gmsg-head">
        <span class="gmsg-name" :style="{ color: role?.color ?? token.colorTextSecondary }">
          {{ role?.name ?? message.author }}
        </span>
        <!-- 复制放在名字行:文档动辄几千字,按钮跟着正文走到底部就没人找得到 -->
        <span class="gmsg-copy"
          ><CopyButton :text="copyText" :label="t('common.copyThisDocument')"
        /></span>
      </div>
      <div class="gmsg-bubble" :style="{ background: token.colorFillQuaternary }">
        <!-- 解说与工具调用按发生顺序交替,读起来是一条链而不是一坨 -->
        <template v-for="(seg, index) in segments" :key="index">
          <GroupMarkdownStream
            v-if="seg.kind === 'text'"
            :content="seg.text"
            :members="collab.mentionMembers"
            :streaming="streaming && index === segments.length - 1"
          />
          <ToolActivityList
            v-else
            :activities="seg.activities"
            :streaming="streaming && seg.activities.some((a) => isActiveToolState(a.state))"
          />
        </template>

        <div v-if="streaming && !textContent" class="gmsg-typing">
          <span class="typing-dot" /><span class="typing-dot" /><span class="typing-dot" />
        </div>
        <a-typography-text
          v-else-if="message.status === 'error'"
          type="danger"
          style="font-size: 12px"
        >
          {{ t('common.generationFailed') }}
        </a-typography-text>
        <a-typography-text
          v-else-if="message.status === 'aborted'"
          type="secondary"
          style="font-size: 12px"
        >
          {{ t('common.stopped') }}
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

.gmsg-head {
  display: flex;
  align-items: center;
  gap: 4px;
  margin: 2px 0 4px;
}

.gmsg-name {
  font-size: 12px;
  font-weight: 600;
}

/*
 * 复制按钮 hover 才现身:一屏十几条消息,每条都常驻一个图标会把版面吵散。
 * 但**键盘焦点也要现身**,否则 tab 到一个看不见的按钮上。
 */
.gmsg-copy {
  opacity: 0;
  transition: opacity 0.15s;
}

.gmsg:hover .gmsg-copy,
.gmsg-copy:focus-within {
  opacity: 1;
}

/* 用户气泡右对齐,按钮摆在气泡左边,不挤压正文宽度 */
.gmsg--user .gmsg-copy {
  align-self: center;
  color: inherit;
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
