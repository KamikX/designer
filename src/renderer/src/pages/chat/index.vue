<script setup lang="ts">
import { App, theme } from 'antdv-next'
import {
  DeleteOutlined,
  FileTextOutlined,
  FolderOpenOutlined,
  GlobalOutlined,
  MessageOutlined,
  PlusOutlined,
  SelectOutlined
} from '@antdv-next/icons'
import { useChatStore } from '@renderer/stores/chat'
import MessageItem from '../project/components/MessageItem.vue'
import Composer from '../project/components/Composer.vue'
import type { ChatAttachment } from '@renderer/stores/chat'
import type { Conversation } from '@shared/types'

/**
 * 纯聊天。
 *
 * 和设计工作台共用 Composer / MessageItem / chat store——差别只在**没有项目**:
 * 没有版本、没有文件树、没有预览,也**不带任何预设提示词**。模型是干净的,
 * 问什么答什么。
 *
 * 两种形态:
 *
 * - **还没选会话**:居中的起始页,输入框在正中间,下面是几张快捷入口卡片
 * - **进了某条会话**:消息在上、输入框贴底,和工作台一致
 *
 * 起始页**不预先建会话**——用户点"新对话"只是想开个头,真到发出第一句才
 * 落库。否则每点一次就在列表里留一条永远空着的记录。
 */

const { token } = theme.useToken()
const { modal } = App.useApp()
const chatStore = useChatStore()

const chats = ref<Conversation[]>([])
const activeId = ref('')
const listEl = ref<HTMLElement | null>(null)
const composerRef = ref<{ setDraft: (text: string) => void } | null>(null)

/** 起始页快捷入口。挑的是这个聊天**区别于浏览器里那个标签页**的能力 */
const STARTERS = [
  {
    icon: FolderOpenOutlined,
    title: '分析本地项目',
    hint: '授权一个目录,让我摸清它的技术栈和结构',
    draft:
      '我想让你了解一下我的项目。我待会授权一个目录给你,你先浏览一遍结构,再告诉我它用了什么技术栈、代码组织方式是怎样的。'
  },
  {
    icon: FileTextOutlined,
    title: '读一份文档',
    hint: 'pdf / docx / xlsx 拖进来就行',
    draft: '我会附上一份文档,帮我读完之后提炼要点。'
  },
  {
    icon: GlobalOutlined,
    title: '联网查资料',
    hint: '搜索 + 打开页面读正文',
    draft: '帮我查一下 ',
    web: true
  },
  {
    icon: SelectOutlined,
    title: '操作网页',
    hint: '打开页面、点击、填表单',
    draft: '帮我打开这个页面并操作:',
    web: true
  }
] as const

async function reload(): Promise<void> {
  chats.value = await window.api.chatSession.list()
}

async function open(id: string): Promise<void> {
  activeId.value = id
  // 传整条会话而不是 id:store 要从 settings 里恢复模型 / 技能 / 联网开关,
  // 只给 id 的话它还得自己再查一次
  chatStore.openChat(chats.value.find((c) => c.id === id) ?? null)
  await chatStore.openConversation(id)
  scrollToBottom(false)
}

/** 回起始页。会话真正创建推迟到发出第一句 */
function startNew(): void {
  activeId.value = ''
  chatStore.openChat(null)
  chatStore.closeConversation()
}

function useStarter(starter: (typeof STARTERS)[number]): void {
  if ('web' in starter && starter.web) chatStore.webSearch = true
  composerRef.value?.setDraft(starter.draft)
}

/**
 * 发送。起始页发的第一句要先把会话建出来。
 *
 * 建会话统一走 store 的 ensureChat,不在这里自己建:Composer 拖文件时也会
 * 调它,两处各建各的话,"先拖个文件再发送"就会造出两条会话——而且第二条
 * 才是消息落进去的那条,拖进来的授权留在了第一条上。
 */
async function send(text: string, attachments: ChatAttachment[]): Promise<void> {
  await chatStore.ensureChat()
  await chatStore.send(text, attachments)
}

function remove(chat: Conversation): void {
  modal.confirm({
    title: `删除「${chat.title || '新对话'}」?`,
    content: '这条对话的消息和它授权过的本地目录都会一起删除。',
    okType: 'danger',
    onOk: async () => {
      await window.api.chatSession.remove(chat.id)
      chats.value = chats.value.filter((c) => c.id !== chat.id)
      if (activeId.value === chat.id) startNew()
    }
  })
}

// 进来先看历史,但**不自动打开**任何一条——起始页本身就是个有用的入口
onMounted(async () => {
  await reload()
  startNew()
})

// Composer 可能自己把会话建出来(往起始页拖文件时),这里跟着切过去,
// 否则界面还停在起始页,而消息已经落到一条看不见的会话里了
watch(
  () => chatStore.conversationId,
  (id) => {
    if (id && id !== activeId.value) {
      activeId.value = id
      void reload()
    }
  }
)

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
      <a-button block size="small" style="margin-bottom: 10px" @click="startNew">
        <template #icon><PlusOutlined /></template>
        新对话
      </a-button>

      <div
        v-if="chats.length === 0"
        class="chat-sider-empty"
        :style="{ color: token.colorTextQuaternary }"
      >
        还没有历史对话
      </div>

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

    <!-- 起始页:输入框在正中间 -->
    <div v-if="!activeId" class="chat-start">
      <div class="chat-start-inner">
        <div class="chat-start-title">有什么可以帮你的?</div>
        <div class="chat-start-sub" :style="{ color: token.colorTextTertiary }">
          这是一个干净的对话,没有任何预设。
        </div>

        <Composer ref="composerRef" class="chat-start-composer" @send="send" />

        <div class="chat-cards">
          <button
            v-for="s in STARTERS"
            :key="s.title"
            type="button"
            class="chat-card"
            :style="{ borderColor: token.colorBorderSecondary }"
            @click="useStarter(s)"
          >
            <component :is="s.icon" :style="{ color: token.colorPrimary }" />
            <span class="chat-card-title">{{ s.title }}</span>
            <span class="chat-card-hint" :style="{ color: token.colorTextTertiary }">
              {{ s.hint }}
            </span>
          </button>
        </div>
      </div>
    </div>

    <!-- 会话页:消息在上,输入框贴底 -->
    <div v-else class="chat-main">
      <div ref="listEl" class="chat-messages">
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
        <Composer @send="send" />
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

.chat-sider-empty {
  font-size: 12px;
  text-align: center;
  padding: 16px 0;
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

/* ---------------- 起始页 ---------------- */

.chat-start {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow-y: auto;
  padding-left: 16px;
}

.chat-start-inner {
  width: 100%;
  max-width: 680px;
  /* 略微偏上:完全垂直居中时,下面的卡片会把视觉重心压得太低 */
  margin-bottom: 6vh;
}

.chat-start-title {
  font-size: 26px;
  font-weight: 600;
  text-align: center;
}

.chat-start-sub {
  margin-top: 8px;
  margin-bottom: 22px;
  font-size: 13px;
  text-align: center;
}

.chat-cards {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: 10px;
  margin-top: 18px;
}

.chat-card {
  display: grid;
  grid-template-columns: 18px 1fr;
  grid-template-areas: 'icon title' 'icon hint';
  gap: 2px 10px;
  text-align: left;
  padding: 12px;
  border: 1px solid;
  border-radius: 12px;
  background: none;
  cursor: pointer;
  transition: background 0.15s;
}

.chat-card:hover {
  background: rgba(128, 128, 128, 0.08);
}

.chat-card > :first-child {
  grid-area: icon;
  align-self: center;
}

.chat-card-title {
  grid-area: title;
  font-size: 13px;
  font-weight: 500;
}

.chat-card-hint {
  grid-area: hint;
  font-size: 11px;
  line-height: 1.5;
}

/* ---------------- 会话页 ---------------- */

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

.chat-composer {
  flex-shrink: 0;
  padding-top: 8px;
}
</style>
