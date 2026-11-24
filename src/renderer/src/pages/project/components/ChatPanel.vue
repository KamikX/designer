<script setup lang="ts">
import { t, uiMessage } from '@renderer/i18n'
import { useRouter } from 'vue-router'
import { theme } from 'antdv-next'
import { MessageOutlined } from '@antdv-next/icons'
import { useArtifactStore } from '@renderer/stores/artifact'
import { useChatStore } from '@renderer/stores/chat'
import { useProviderStore } from '@renderer/stores/provider'
import MessageItem from './MessageItem.vue'
import Composer from './Composer.vue'
import type { Project } from '@shared/types'

const props = defineProps<{ project: Project }>()

/** 对话面板:消息流(自动贴底)+ 一体化输入框。 */

const router = useRouter()
const { token } = theme.useToken()
const chatStore = useChatStore()
const artifactStore = useArtifactStore()
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
        :message="t('还没有可用的模型')"
        style="margin-bottom: 12px"
      >
        <template #description>
          {{ t('先到设置里添加供应商、录入 API Key 并启用模型。') }}
          <a @click="router.push('/settings')">{{ t('前往设置') }}</a>
        </template>
      </a-alert>

      <!--
        空态和首页那个"新建第一个项目"用同一副骨架:淡到几乎不见的线性图标
        + 真 h2(衬线由 base.css 给)+ 一句 13px 的说明。
        原来那块蓝紫渐变方块里放一个 ✦,渐变和装饰性字符都是模板感的来源,
        而且它什么都没说明。
      -->
      <div v-if="chatStore.messages.length === 0 && !noModel" class="chat-empty">
        <div class="chat-empty-inner">
          <MessageOutlined class="chat-empty-icon" :style="{ color: token.colorTextQuaternary }" />
          <h2 class="chat-empty-title">{{ t('开始你的设计') }}</h2>
          <div class="chat-empty-sub" :style="{ color: token.colorTextTertiary }">
            {{ t('描述页面、风格、内容,AI 会生成可预览的多文件设计稿;') }}
            <br />
            {{ t('后续可以继续对话逐步调整') }}
          </div>
        </div>
      </div>

      <MessageItem v-for="m in chatStore.messages" :key="m.id" :message="m" />

      <a-alert
        v-if="chatStore.error"
        type="error"
        :message="uiMessage(chatStore.error)"
        show-icon
        closable
      />
    </div>

    <div class="chat-composer">
      <Composer
        :disabled="
          noModel ||
          chatStore.sending ||
          artifactStore.loading ||
          artifactStore.projectId !== project.id
        "
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

/* 撑满剩余高度再居中,不用固定的 margin-top:面板高度随窗口和输入框行数变,
   写死 96px 在矮窗口上会顶到底、在高窗口上又贴在上沿 */
.chat-empty {
  min-height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
}

.chat-empty-inner {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  text-align: center;
}

.chat-empty-icon {
  font-size: 28px;
}

/* 字号/字重/衬线全部来自 base.css 的 h2,这里只清掉浏览器默认外边距 */
.chat-empty-title {
  margin: 0;
}

.chat-empty-sub {
  font-size: 13px;
  line-height: 1.7;
}

.chat-composer {
  flex-shrink: 0;
  padding-top: 8px;
}
</style>
