<script setup lang="ts">
import { useRouter } from 'vue-router'
import { useChatStore } from '@renderer/stores/chat'
import { useProviderStore } from '@renderer/stores/provider'
import MessageItem from './MessageItem.vue'
import Composer from './Composer.vue'
import type { Project } from '@shared/types'

const props = defineProps<{ project: Project }>()

/** 对话面板:消息流(自动贴底)+ 一体化输入框。 */

const router = useRouter()
const chatStore = useChatStore()
const providerStore = useProviderStore()

const listEl = ref<HTMLElement | null>(null)

watch(
  () => props.project.id,
  async (projectId) => {
    // 同步先行,不放在 await 后面:Composer 与 ModelSelect 都监听
    // chatStore.projectId,它们挂载时这个值必须已经是新项目的
    chatStore.openProject(props.project)
    const conversation = await window.api.conversation.ensureDesign(projectId)
    await chatStore.openConversation(conversation.id)
    scrollToBottom(false)
  },
  { immediate: true }
)

watch(
  () => [chatStore.messages.length, chatStore.messages.at(-1)?.parts.at(-1)],
  () => scrollToBottom(true),
  { deep: false }
)

function scrollToBottom(smooth: boolean): void {
  nextTick(() => {
    listEl.value?.scrollTo({ top: listEl.value.scrollHeight, behavior: smooth ? 'smooth' : 'auto' })
  })
}

const noModel = computed(() => providerStore.loaded && providerStore.chatModels.length === 0)
</script>

<template>
  <div class="chat-panel">
    <div ref="listEl" class="chat-messages">
      <a-alert
        v-if="noModel"
        type="warning"
        show-icon
        message="还没有可用的模型"
        style="margin-bottom: 12px"
      >
        <template #description>
          先到设置里添加供应商、录入 API Key 并启用模型。
          <a @click="router.push('/settings')">前往设置</a>
        </template>
      </a-alert>

      <div v-if="chatStore.messages.length === 0 && !noModel" class="chat-empty">
        <div class="chat-empty-icon">✦</div>
        <div class="chat-empty-title">开始你的设计</div>
        <div class="chat-empty-sub">
          描述页面、风格、内容,AI 会生成可预览的多文件设计稿;
          <br />
          后续可以继续对话逐步调整
        </div>
      </div>

      <MessageItem v-for="m in chatStore.messages" :key="m.id" :message="m" />

      <a-alert v-if="chatStore.error" type="error" :message="chatStore.error" show-icon closable />
    </div>

    <div class="chat-composer">
      <Composer
        :disabled="noModel"
        @send="(text, attachments) => chatStore.send(text, attachments)"
      />
    </div>
  </div>
</template>

<style scoped>
/* 左右间距由外层的 .chat-pane 给,这里不管——间距集中在布局那一层 */
.chat-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}

.chat-messages {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  /*
   * 右边那 4px 是滚动条的让位:滚动条占的是内容区宽度,不留一点消息会直接
   * 顶在它上面(Windows 上尤其明显)。因此消息列表比输入框窄这 4px,是有意的。
   * 左右主边距由 .chat-pane 给,这里不要再加,否则又变成两个来源。
   */
  padding: 4px 4px 8px 0;
}

.chat-empty {
  margin-top: 96px;
  text-align: center;
}

.chat-empty-icon {
  width: 48px;
  height: 48px;
  margin: 0 auto 14px;
  border-radius: 16px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 22px;
  color: #fff;
  background: linear-gradient(135deg, #6a8dff, #9b6aff);
}

.chat-empty-title {
  font-size: 15px;
  font-weight: 600;
}

.chat-empty-sub {
  margin-top: 6px;
  font-size: 12px;
  line-height: 1.8;
  opacity: 0.55;
}

.chat-composer {
  flex-shrink: 0;
  padding-top: 8px;
}
</style>
