<script setup lang="ts">
import { App, theme } from 'antdv-next'
import { DeleteOutlined, LoadingOutlined, PlusOutlined, TeamOutlined } from '@antdv-next/icons'
import { useCollabStore } from '@renderer/stores/collab'
import MemberBar from './components/MemberBar.vue'
import GroupMessage from './components/GroupMessage.vue'
import GroupComposer from './components/GroupComposer.vue'
import CreateGroupModal from './components/CreateGroupModal.vue'
import type { Conversation } from '@shared/types'

/**
 * 多 agent 协作群组。布局与聊天页同构:左侧群列表,右侧主区。
 *
 * 工作机制:用户 @某个角色(如 @产品经理)→ 该 agent 流式产出 markdown
 * 文档 → 它在末尾 @下一位 → 链条自动接力,直到没人再被 @。用户消息里
 * 不 @ 任何角色就只是留言。
 */

const { token } = theme.useToken()
const { modal, message } = App.useApp()
const collab = useCollabStore()

const createOpen = ref(false)
const listEl = ref<HTMLElement | null>(null)

onMounted(() => {
  void collab.init()
})

async function open(id: string): Promise<void> {
  if (collab.conversationId === id) return
  await collab.openGroup(id)
  scrollToBottom(false)
}

function remove(group: Conversation): void {
  modal.confirm({
    title: `删除「${group.title}」?`,
    content: '群里的全部消息和授权过的本地目录都会一起删除。',
    okType: 'danger',
    onOk: async () => {
      await collab.removeGroup(group.id)
    }
  })
}

function onCreated(group: Conversation): void {
  void open(group.id)
}

async function resumeChain(): Promise<void> {
  try {
    await collab.resumeChain()
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
  }
}

watch(
  () => [collab.messages.length, collab.messages.at(-1)?.parts.at(-1)],
  () => scrollToBottom(true)
)

function scrollToBottom(smooth: boolean): void {
  nextTick(() => {
    listEl.value?.scrollTo({ top: listEl.value.scrollHeight, behavior: smooth ? 'smooth' : 'auto' })
  })
}
</script>

<template>
  <div class="collab-page">
    <div class="collab-sider" :style="{ borderColor: token.colorBorderSecondary }">
      <a-button block size="small" style="margin-bottom: 10px" @click="createOpen = true">
        <template #icon><PlusOutlined /></template>
        新建群组
      </a-button>

      <div
        v-if="collab.groups.length === 0"
        class="collab-sider-empty"
        :style="{ color: token.colorTextQuaternary }"
      >
        还没有群组
      </div>

      <div
        v-for="group in collab.groups"
        :key="group.id"
        class="collab-item"
        :style="
          group.id === collab.conversationId
            ? { background: token.colorPrimaryBg, color: token.colorPrimary }
            : { color: token.colorTextSecondary }
        "
      >
        <button
          class="collab-item-open"
          type="button"
          @click="open(group.id)"
          @keydown.enter.prevent="open(group.id)"
        >
          <!-- 有接力在跑就转圈:后台群也一样,让用户一眼看到哪个群在干活 -->
          <LoadingOutlined
            v-if="collab.chaining[group.id]"
            spin
            :style="{ color: token.colorPrimary }"
          />
          <TeamOutlined v-else />
          <span class="collab-item-title">{{ group.title }}</span>
        </button>
        <button
          class="collab-item-remove"
          type="button"
          :aria-label="`删除群组 ${group.title}`"
          @click="remove(group)"
        >
          <DeleteOutlined />
        </button>
      </div>
    </div>

    <!-- 空状态:告诉用户这里怎么玩,而不是一片白 -->
    <div v-if="!collab.conversationId" class="collab-empty">
      <div class="collab-empty-inner">
        <TeamOutlined class="collab-empty-icon" :style="{ color: token.colorPrimary }" />
        <div class="collab-empty-title">让一组 AI 角色接力干活</div>
        <div class="collab-empty-steps" :style="{ color: token.colorTextTertiary }">
          1. 新建一个群组,勾选需要的角色<br />
          2. (可选)授权本地目录,让它们参考你的真实项目<br />
          3. @产品经理 说你要做什么——它产出文档后会 @下一位,链条自动接力
        </div>
        <a-button type="primary" @click="createOpen = true">
          <template #icon><PlusOutlined /></template>
          新建群组
        </a-button>
      </div>
    </div>

    <!-- 群主区:成员条 + 消息 + 输入区 -->
    <div v-else class="collab-main">
      <MemberBar />
      <div ref="listEl" class="collab-messages">
        <GroupMessage v-for="m in collab.messages" :key="m.id" :message="m" />
        <a-alert
          v-if="collab.error"
          :type="collab.resumeMember ? 'warning' : 'error'"
          :message="collab.error"
          show-icon
          closable
          @close="collab.error = ''"
        >
          <template v-if="collab.resumeMember" #action>
            <!-- 拦停是有界循环的检查点:一键续棒 = 发一条 @成员 的新消息开新链 -->
            <a-button size="small" :loading="collab.chainingHere" @click="resumeChain">
              让「{{ collab.resumeMember.name }}」继续接力
            </a-button>
          </template>
        </a-alert>
      </div>
      <div class="collab-composer">
        <GroupComposer />
      </div>
    </div>

    <CreateGroupModal v-model:open="createOpen" @created="onCreated" />
  </div>
</template>

<style scoped>
.collab-page {
  display: flex;
  height: 100%;
  min-height: 0;
  padding: 0 var(--page-pad) var(--page-pad);
}

.collab-sider {
  width: 200px;
  flex-shrink: 0;
  overflow-y: auto;
  padding-right: 12px;
  border-right: 1px solid;
}

.collab-sider-empty {
  font-size: 12px;
  text-align: center;
  padding: 16px 0;
}

.collab-item {
  display: flex;
  align-items: center;
  padding: 0 6px 0 0;
  border-radius: 8px;
  font-size: 12px;
}

.collab-item:hover .collab-item-remove {
  opacity: 0.6;
}

.collab-item-open {
  display: flex;
  flex: 1;
  min-width: 0;
  align-items: center;
  gap: 6px;
  padding: 6px 8px;
  border: none;
  background: none;
  color: inherit;
  cursor: pointer;
  font: inherit;
  text-align: left;
}

.collab-item-open:focus-visible,
.collab-item-remove:focus-visible {
  outline: 2px solid var(--ant-color-primary);
  outline-offset: 1px;
}

.collab-item-title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 常态隐藏,悬停才出现:一排删除图标会把列表变得很吵 */
.collab-item-remove {
  border: none;
  background: none;
  cursor: pointer;
  color: inherit;
  opacity: 0;
  padding: 0 2px;
  transition: opacity 0.15s;
}

.collab-item-remove:hover {
  opacity: 1;
}

.collab-item-remove:focus-visible {
  opacity: 1;
}

/* ---------------- 空状态 ---------------- */

.collab-empty {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  padding-left: 16px;
}

.collab-empty-inner {
  text-align: center;
  max-width: 420px;
  /* 略微偏上,和聊天起始页同一个视觉重心 */
  margin-bottom: 6vh;
}

.collab-empty-icon {
  font-size: 34px;
}

.collab-empty-title {
  font-size: 20px;
  font-weight: 600;
  margin: 14px 0 10px;
}

.collab-empty-steps {
  font-size: 13px;
  line-height: 2;
  text-align: left;
  margin-bottom: 20px;
}

/* ---------------- 群主区 ---------------- */

.collab-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  min-height: 0;
  padding-left: 16px;
}

.collab-messages {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 12px 4px 8px 0;
}

.collab-composer {
  flex-shrink: 0;
  padding-top: 8px;
}
</style>
