<script setup lang="ts">
import { t, uiMessage } from '@renderer/i18n'
import { App, theme } from 'antdv-next'
import {
  DeleteOutlined,
  LoadingOutlined,
  PlusOutlined,
  SettingOutlined,
  TeamOutlined
} from '@antdv-next/icons'
import { useCollabStore } from '@renderer/stores/collab'
import MemberBar from './components/MemberBar.vue'
import GroupMessage from './components/GroupMessage.vue'
import GroupComposer from './components/GroupComposer.vue'
import GroupFormModal from './components/GroupFormModal.vue'
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

const formOpen = ref(false)
/** 编辑目标;null = 新建模式。两种模式共用同一个表单弹窗 */
const editTarget = ref<Conversation | null>(null)
const listEl = ref<HTMLElement | null>(null)

function openCreate(): void {
  editTarget.value = null
  formOpen.value = true
}

function openEdit(group: Conversation): void {
  editTarget.value = group
  formOpen.value = true
}

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
    get title() {
      return t('common.delete', group.title)
    },
    content: t('messages.allGroupMessagesAndAccessToLocalDirectoriesWillBeDeleted'),
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
    message.error(uiMessage(err instanceof Error ? err.message : String(err)))
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
      <a-button block size="small" style="margin-bottom: 10px" @click="openCreate">
        <template #icon><PlusOutlined /></template>
        {{ t('common.newGroup') }}
      </a-button>

      <div
        v-if="collab.groups.length === 0"
        class="collab-sider-empty"
        :style="{ color: token.colorTextQuaternary }"
      >
        {{ t('common.noGroupsYet') }}
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
        <!-- 接力进行中禁改:每一棒开始时都重读成员配置,链中换配置=中途换人设 -->
        <button
          class="collab-item-action"
          type="button"
          :aria-label="t('common.groupSettingsLabel', group.title)"
          :disabled="collab.chaining[group.id]"
          @click="openEdit(group)"
        >
          <SettingOutlined />
        </button>
        <button
          class="collab-item-action"
          type="button"
          :aria-label="t('common.deleteGroup', group.title)"
          @click="remove(group)"
        >
          <DeleteOutlined />
        </button>
      </div>
    </div>

    <!-- 空状态:告诉用户这里怎么玩,而不是一片白 -->
    <div v-if="!collab.conversationId" class="collab-empty">
      <div class="collab-empty-inner">
        <!-- 装饰性图标不上品牌色:颜色留给状态和行动,这里只是个标记 -->
        <TeamOutlined class="collab-empty-icon" :style="{ color: token.colorTextQuaternary }" />
        <h2 class="collab-empty-title">{{ t('messages.letATeamOfAiRolesWorkTogether') }}</h2>
        <div class="collab-empty-steps" :style="{ color: token.colorTextTertiary }">
          {{ t('messages.1CreateAGroupAndSelectTheRolesYouNeed') }}<br />
          {{ t('messages.2OptionallyGrantAccessToLocalDirectoriesSoTheyCanReferenceYourProject')
          }}<br />
          {{ t('messages.3MentionAMemberToStart') }}
        </div>
        <a-button type="primary" @click="openCreate">
          <template #icon><PlusOutlined /></template>
          {{ t('common.newGroup') }}
        </a-button>
      </div>
    </div>

    <!-- 群主区:成员条 + 消息 + 输入区 -->
    <div v-else class="collab-main">
      <MemberBar />
      <div ref="listEl" class="collab-messages">
        <!-- 带上 DOM id:交付物面板据此跳到承载那份文档的消息 -->
        <GroupMessage v-for="m in collab.messages" :id="`gmsg-${m.id}`" :key="m.id" :message="m" />
        <a-alert
          v-if="collab.error"
          :type="collab.resumeMember ? 'warning' : 'error'"
          :message="uiMessage(collab.error)"
          show-icon
          closable
          @close="collab.error = ''"
        >
          <template v-if="collab.resumeMember" #action>
            <!-- 拦停是有界循环的检查点:一键续棒 = 发一条 @成员 的新消息开新链 -->
            <a-button size="small" :loading="collab.chainingHere" @click="resumeChain">
              {{ t('common.let') }}{{ collab.resumeMember.name
              }}{{ t('messages.continueTheRelay') }}
            </a-button>
          </template>
        </a-alert>
      </div>
      <div class="collab-composer">
        <GroupComposer />
      </div>
    </div>

    <GroupFormModal v-model:open="formOpen" :group="editTarget" @created="onCreated" />
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

.collab-item:hover .collab-item-action {
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
.collab-item-action:focus-visible {
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

/* 常态隐藏,悬停才出现:一排操作图标会把列表变得很吵 */
.collab-item-action {
  border: none;
  background: none;
  cursor: pointer;
  color: inherit;
  opacity: 0;
  padding: 0 2px;
  transition: opacity 0.15s;
}

.collab-item-action:hover:not(:disabled) {
  opacity: 1;
}

.collab-item-action:focus-visible {
  opacity: 1;
}

.collab-item-action:disabled {
  cursor: not-allowed;
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
  margin: 0;
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
