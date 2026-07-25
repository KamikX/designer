<script setup lang="ts">
import { App, theme } from 'antdv-next'
import { DeleteOutlined, MessageOutlined, PlusOutlined } from '@antdv-next/icons'
import { useChatStore } from '@renderer/stores/chat'
import MessageItem from '../project/components/MessageItem.vue'
import Composer from '../project/components/Composer.vue'
import type { Conversation } from '@shared/types'

/**
 * 纯聊天。
 *
 * 和设计工作台共用 Composer / MessageItem / chat store——差别只在**没有项目**:
 * 没有版本、没有文件树、没有预览,也**不带任何预设提示词**。模型是干净的,
 * 问什么答什么。
 *
 * 用户能力(本地目录、技能、MCP、附件、联网)全都在输入框工具条里,
 * 和工作台是同一套,不用学第二遍。
 */

const { token } = theme.useToken()
const { modal } = App.useApp()
const chatStore = useChatStore()

const chats = ref<Conversation[]>([])
const activeId = ref('')
const listEl = ref<HTMLElement | null>(null)

async function reload(): Promise<void> {
  chats.value = await window.api.chatSession.list()
}

async function open(id: string): Promise<void> {
  activeId.value = id
  chatStore.openChat(id)
  await chatStore.openConversation(id)
  scrollToBottom(false)
}

async function create(): Promise<void> {
  const created = await window.api.chatSession.create()
  chats.value = [created, ...chats.value]
  await open(created.id)
}

function remove(chat: Conversation): void {
  modal.confirm({
    title: `删除「${chat.title || '新对话'}」?`,
    content: '这条对话的消息和它授权过的本地目录都会一起删除。',
    okType: 'danger',
    onOk: async () => {
      await window.api.chatSession.remove(chat.id)
      chats.value = chats.value.filter((c) => c.id !== chat.id)
      // 删的正好是当前这条:切到还剩的第一条,没有就开一条新的
      if (activeId.value === chat.id) {
        if (chats.value[0]) await open(chats.value[0].id)
        else await create()
      }
    }
  })
}

onMounted(async () => {
  await reload()
  // 进来就能直接说话:有历史开最近一条,没有就建一条
  if (chats.value[0]) await open(chats.value[0].id)
  else await create()
})

// 首句会被主进程用作标题,发完刷一次列表让它显示出来
watch(
  () => chatStore.streaming,
  (now, before) => {
    if (before && !now) void reload()
  }
)

watch(
  () => [chatStore.messages.length, chatStore.messages.at(-1)?.parts.at(-1)],
  () => scrollToBottom(true)
)

function scrollToBottom(smooth: boolean): void {
  nextTick(() => {
    listEl.value?.scrollTo({ top: listEl.value.scrollHeight, behavior: smooth ? 'smooth' : 'auto' })
  })
}
</script>

<template>
  <div class="chat-page">
    <div class="chat-sider" :style="{ borderColor: token.colorBorderSecondary }">
      <a-button block size="small" type="primary" style="margin-bottom: 10px" @click="create">
        <template #icon><PlusOutlined /></template>
        新对话
      </a-button>

      <div
        v-for="chat in chats"
        :key="chat.id"
        class="chat-item"
        :style="
          chat.id === activeId
            ? { background: token.colorPrimaryBg, color: token.colorPrimary }
            : { color: token.colorTextSecondary }
        "
        @click="open(chat.id)"
      >
        <MessageOutlined />
        <span class="chat-item-title">{{ chat.title || '新对话' }}</span>
        <button class="chat-item-remove" type="button" @click.stop="remove(chat)">
          <DeleteOutlined />
        </button>
      </div>
    </div>

    <div class="chat-main">
      <div ref="listEl" class="chat-messages">
        <div v-if="chatStore.messages.length === 0" class="chat-empty">
          <div class="chat-empty-title">有什么可以帮你的?</div>
          <div class="chat-empty-sub" :style="{ color: token.colorTextTertiary }">
            这是一个干净的对话,没有任何预设。
            <br />
            需要的话,在下面开启联网、授权本地目录、挂上技能或 MCP。
          </div>
        </div>

        <MessageItem v-for="m in chatStore.messages" :key="m.id" :message="m" />

        <a-alert
          v-if="chatStore.error"
          type="error"
          :message="chatStore.error"
          show-icon
          closable
        />
      </div>

      <div class="chat-composer">
        <Composer @send="(text, files) => chatStore.send(text, files)" />
      </div>
    </div>
  </div>
</template>

<style scoped>
.chat-page {
  display: flex;
  height: 100%;
  min-height: 0;
  padding: 0 var(--page-pad) var(--page-pad);
}

.chat-sider {
  width: 200px;
  flex-shrink: 0;
  overflow-y: auto;
  padding-right: 12px;
  border-right: 1px solid;
}

.chat-item {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 8px;
  border-radius: 8px;
  cursor: pointer;
  font-size: 12px;
}

.chat-item:hover .chat-item-remove {
  opacity: 0.6;
}

.chat-item-title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 常态隐藏,悬停才出现:一排删除图标会把列表变得很吵 */
.chat-item-remove {
  border: none;
  background: none;
  cursor: pointer;
  color: inherit;
  opacity: 0;
  padding: 0 2px;
  transition: opacity 0.15s;
}

.chat-item-remove:hover {
  opacity: 1;
}

.chat-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  min-height: 0;
  padding-left: 16px;
}

.chat-messages {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 4px 4px 8px 0;
}

.chat-empty {
  margin-top: 120px;
  text-align: center;
}

.chat-empty-title {
  font-size: 18px;
  font-weight: 600;
}

.chat-empty-sub {
  margin-top: 8px;
  font-size: 12px;
  line-height: 1.9;
}

.chat-composer {
  flex-shrink: 0;
  padding-top: 8px;
}
</style>
