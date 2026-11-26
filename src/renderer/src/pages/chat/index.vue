<script setup lang="ts">
import { t, uiMessage } from '@renderer/i18n'
import { App, theme } from 'antdv-next'
import {
  DeleteOutlined,
  FileTextOutlined,
  FolderOpenOutlined,
  GlobalOutlined,
  LoadingOutlined,
  MessageOutlined,
  PlusOutlined,
  SelectOutlined
} from '@antdv-next/icons'
import { useChatStore } from '@renderer/stores/chat'
import MessageHistory from '../project/components/MessageHistory.vue'
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
const STARTERS = computed(() => [
  {
    icon: FolderOpenOutlined,
    title: t('messages.analyzeALocalProject'),
    hint: t('messages.grantAccessToADirectoryToInspectItsStackAndStructure'),
    draft: t('messages.iWillGrantAccessToMy')
  },
  {
    icon: FileTextOutlined,
    title: t('common.readADocument'),
    hint: t('messages.dragInAPdfDocxOrXlsxFile'),
    draft: t('messages.iWillAttachADocumentPleaseReadItAndSummarizeTheKeyPoints')
  },
  {
    icon: GlobalOutlined,
    title: t('common.searchTheWeb'),
    hint: t('messages.searchAndReadWebPages'),
    draft: t('messages.pleaseLookUp'),
    web: true
  },
  {
    icon: SelectOutlined,
    title: t('messages.interactWithAWebPage'),
    hint: t('messages.openPagesClickAndFillInForms'),
    draft: t('messages.pleaseOpenAndInteractWithThisPage'),
    web: true
  }
])

async function reload(): Promise<void> {
  chats.value = await window.api.chatSession.list()
}

async function open(id: string): Promise<void> {
  activeId.value = id
  // 列表是快照,settings 可能已被会话内的改动写过库(改模型不触发 reload)。
  // 恢复前先拉最新的,否则切走再切回来,刚选的模型/技能就"丢了"。
  // 传整条会话而不是 id:store 要从 settings 里恢复模型 / 技能 / 联网开关
  await reload()
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

function useStarter(starter: (typeof STARTERS.value)[number]): void {
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
    title: t('common.delete', chat.title || t('common.newConversation')),
    content: t('messages.thisConversationSMessagesAndItsAccessToLocalDirectoriesWillBeDeleted'),
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
  () => [chatStore.messages.length, chatStore.messages.at(-1)?.parts.at(-1)] as const,
  (now, before) => {
    if (now[0] < before[0]) return
    scrollToBottom(true)
  }
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
        {{ t('common.newConversation') }}
      </a-button>

      <div
        v-if="chats.length === 0"
        class="chat-sider-empty"
        :style="{ color: token.colorTextQuaternary }"
      >
        {{ t('common.noConversationsYet') }}
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
        <!-- 有流在跑就转圈:后台会话也一样,让用户一眼看到哪条在干活 -->
        <LoadingOutlined
          v-if="chatStore.streams[chat.id]"
          spin
          :style="{ color: token.colorPrimary }"
        />
        <MessageOutlined v-else />
        <span class="chat-item-title">{{ chat.title || t('common.newConversation') }}</span>
        <button class="chat-item-remove" type="button" @click.stop="remove(chat)">
          <DeleteOutlined />
        </button>
      </div>
    </div>

    <!-- 起始页:输入框在正中间 -->
    <div v-if="!activeId" class="chat-start">
      <div class="chat-start-inner">
        <h1 class="chat-start-title">{{ t('messages.howCanIHelp') }}</h1>
        <div class="chat-start-sub" :style="{ color: token.colorTextTertiary }">
          {{ t('messages.startAConversationWithoutPresetInstructions') }}
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
        <MessageHistory />
        <a-alert
          v-if="chatStore.error"
          type="error"
          :message="uiMessage(chatStore.error)"
          show-icon
          closable
        />
      </div>
      <div class="chat-composer">
        <Composer :disabled="chatStore.deleting || chatStore.sending" @send="send" />
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
  margin: 0;
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
