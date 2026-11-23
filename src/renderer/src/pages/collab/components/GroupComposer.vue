<script setup lang="ts">
import { t, uiMessage } from '@renderer/i18n'
import { App, theme } from 'antdv-next'
import { ArrowUpOutlined, PauseOutlined } from '@antdv-next/icons'
import { useCollabStore } from '@renderer/stores/collab'
import { createGroupMention } from '@shared/group-mentions'
import type { GroupRoleMeta } from '@shared/types'
import RoleAvatar from './RoleAvatar.vue'

/**
 * 群输入框。上方一排成员 chip(点击插入 @角色名),下面是输入区 + 工具条。
 *
 * 接力进行中发送按钮变**暂停**(不是红色危险按钮):停下来已产出的文档都
 * 逐条落库了,不是什么破坏性操作。
 */

const { token } = theme.useToken()
const { message } = App.useApp()
const collab = useCollabStore()

const draft = shallowRef('')

/** 点成员 chip 往草稿里插「@角色名 」。已经写了一半就接在后面,补个空格分隔 */
function mention(member: GroupRoleMeta): void {
  const tag = `${createGroupMention(member)} `
  if (!draft.value) draft.value = tag
  else draft.value = `${draft.value.replace(/\s+$/, '')} ${tag}`
}

const mentionOptions = computed(() =>
  collab.mentionMembers.map((member) => ({
    label: member.name,
    value: createGroupMention(member).slice(1)
  }))
)

function roleForMentionOption(value: unknown): GroupRoleMeta | null {
  const option = mentionOptions.value.find((item) => item.value === value)
  return collab.mentionMembers.find((member) => member.name === option?.label) ?? null
}

/* ---------------- 发送 / 暂停 ---------------- */

async function send(): Promise<void> {
  const text = draft.value.trim()
  if (!text || collab.chainingHere) return
  draft.value = ''
  try {
    await collab.send(text)
  } catch (err) {
    // 发送失败消息没落库(如上一条链还在跑),草稿还回去,别让用户重打一遍
    draft.value = text
    message.error(uiMessage(err instanceof Error ? err.message : String(err)))
  }
}

function onEnter(e: KeyboardEvent): void {
  // Enter 发送,Shift+Enter 换行(输入法组合期间不触发)
  if (e.shiftKey || e.isComposing) return
  e.preventDefault()
  const valueBeforeMentionsSelection = draft.value
  void nextTick(() => {
    // Mentions 也用 Enter 选择候选；它会在同一轮把草稿替换为提及文本。
    if (draft.value !== valueBeforeMentionsSelection) return
    void send()
  })
}

function onKeydownCapture(e: KeyboardEvent): void {
  if (e.key !== 'Enter' || (!e.shiftKey && !e.isComposing)) return
  // 阻止 Mentions 把 Shift/IME Enter 当成候选确认，但保留 textarea 的默认行为。
  e.stopPropagation()
}
</script>

<template>
  <div class="gcomposer">
    <!-- 成员 chip:点谁就 @ 谁。这排同时也是"链条该从谁开始"的提示 -->
    <div class="gcomposer-chips">
      <button
        v-for="role in collab.memberRoles"
        :key="role.id"
        type="button"
        class="gcomposer-chip"
        :style="{ borderColor: token.colorBorderSecondary, color: token.colorTextSecondary }"
        @click="mention(role)"
      >
        <RoleAvatar :role="role" :size="16" />
        <span>{{ role.name }}</span>
      </button>
    </div>

    <div
      class="gcomposer-box"
      :style="{ background: token.colorBgContainer, borderColor: token.colorBorderSecondary }"
      @keydown.capture="onKeydownCapture"
    >
      <a-mentions
        v-model:value="draft"
        :aria-label="t('群组消息')"
        :options="mentionOptions"
        class="gcomposer-input"
        :placeholder="t('@产品经理 说说你要做什么;不 @ 任何人就只是留言')"
        :auto-size="{ minRows: 2, maxRows: 8 }"
        variant="borderless"
        @keydown.enter="onEnter"
      >
        <template #labelRender="{ option }">
          <span class="gcomposer-option">
            <RoleAvatar :role="roleForMentionOption(option.value)" :size="18" />
            <span>{{ option.label }}</span>
          </span>
        </template>
      </a-mentions>

      <div class="gcomposer-toolbar">
        <a-tooltip :title="collab.chainingHere ? t('停止接力') : t('Enter 发送,Shift+Enter 换行')">
          <a-button
            v-if="collab.chainingHere"
            class="gcomposer-send"
            :aria-label="t('暂停群组接力')"
            type="primary"
            shape="circle"
            @click="collab.abort()"
          >
            <template #icon><PauseOutlined /></template>
          </a-button>
          <a-button
            v-else
            class="gcomposer-send"
            :aria-label="t('发送群组消息')"
            type="primary"
            shape="circle"
            :disabled="!draft.trim()"
            @click="send"
          >
            <template #icon><ArrowUpOutlined /></template>
          </a-button>
        </a-tooltip>
      </div>
    </div>
  </div>
</template>

<style scoped>
.gcomposer-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 8px;
}

.gcomposer-chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  border: 1px solid transparent;
  border-radius: 999px;
  background: none;
  cursor: pointer;
  font-size: 12px;
  padding: 2px 10px 2px 4px;
  transition: background 0.15s;
}

.gcomposer-chip:hover {
  background: rgba(128, 128, 128, 0.12);
}

.gcomposer-box {
  border: 1px solid transparent;
  border-radius: 14px;
  padding: 4px 8px 8px;
  transition: border-color 0.2s;
}

.gcomposer-box:focus-within {
  border-color: var(--ant-color-primary);
}

.gcomposer-input,
.gcomposer-input:focus {
  border: none !important;
  box-shadow: none !important;
  outline: none;
  resize: none;
  font-size: 13px;
  line-height: 1.7;
  background: transparent !important;
}

.gcomposer-option {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.gcomposer-toolbar {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 8px;
  padding: 4px 2px 0 4px;
}

.gcomposer-send {
  flex-shrink: 0;
}
</style>
