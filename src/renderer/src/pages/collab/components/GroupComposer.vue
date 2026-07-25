<script setup lang="ts">
import { App, theme } from 'antdv-next'
import { ArrowUpOutlined, PauseOutlined } from '@antdv-next/icons'
import { useCollabStore } from '@renderer/stores/collab'
import { useProviderStore } from '@renderer/stores/provider'
import { isChoiceAlive } from '@renderer/stores/selection'
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
const providerStore = useProviderStore()
providerStore.load()

const draft = ref('')

/** 点成员 chip 往草稿里插「@角色名 」。已经写了一半就接在后面,补个空格分隔 */
function mention(name: string): void {
  const tag = `@${name} `
  if (!draft.value) draft.value = tag
  else draft.value = `${draft.value.replace(/\s+$/, '')} ${tag}`
}

/* ---------------- 模型选择 ---------------- */

const modelOptions = computed(() =>
  collab.toolModels.map(({ provider, models }) => ({
    label: provider.name,
    options: models.map((m) => ({ label: m.displayName, value: `${provider.id}:${m.id}` }))
  }))
)

const modelValue = computed<string | undefined>({
  get: () =>
    collab.model.providerId && collab.model.modelId
      ? `${collab.model.providerId}:${collab.model.modelId}`
      : undefined,
  set: (v) => {
    if (!v) return
    const [providerId, modelId] = v.split(':')
    collab.selectModel(providerId, modelId)
  }
})

/**
 * 兜底选第一个可用模型。判据和工作台的 ModelSelect 一致:"当前选择还在不在
 * 列表里"——存档里的模型可能已被停用,也可能被去掉了 tools 能力。
 */
watchEffect(() => {
  const groups = collab.toolModels
  if (groups.length === 0) return
  const choice = collab.model.providerId
    ? { providerId: collab.model.providerId, modelId: collab.model.modelId }
    : null
  if (isChoiceAlive(choice, groups)) return
  collab.selectModel(groups[0].provider.id, groups[0].models[0].id)
})

/* ---------------- 发送 / 暂停 ---------------- */

async function send(): Promise<void> {
  const text = draft.value.trim()
  if (!text || collab.chainingHere) return
  if (!collab.model.providerId || !collab.model.modelId) {
    message.warning('先选择一个支持工具调用的模型')
    return
  }
  draft.value = ''
  try {
    await collab.send(text)
  } catch (err) {
    // 发送失败消息没落库(如上一条链还在跑),草稿还回去,别让用户重打一遍
    draft.value = text
    message.error(err instanceof Error ? err.message : String(err))
  }
}

function onEnter(e: KeyboardEvent): void {
  // Enter 发送,Shift+Enter 换行(输入法组合期间不触发)
  if (e.shiftKey || e.isComposing) return
  e.preventDefault()
  void send()
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
        @click="mention(role.name)"
      >
        <RoleAvatar :role="role" :size="16" />
        <span>{{ role.name }}</span>
      </button>
    </div>

    <div
      class="gcomposer-box"
      :style="{ background: token.colorBgContainer, borderColor: token.colorBorderSecondary }"
    >
      <a-textarea
        v-model:value="draft"
        class="gcomposer-input"
        placeholder="@产品经理 说说你要做什么;不 @ 任何人就只是留言"
        :auto-size="{ minRows: 2, maxRows: 8 }"
        variant="borderless"
        @keydown.enter="onEnter"
      />

      <div class="gcomposer-toolbar">
        <a-select
          v-model:value="modelValue"
          :options="modelOptions"
          size="small"
          class="gcomposer-model"
          :placeholder="modelOptions.length ? '选择模型' : '没有支持工具调用的模型'"
          variant="borderless"
          :popup-match-select-width="false"
        />

        <a-tooltip :title="collab.chainingHere ? '停止接力' : 'Enter 发送,Shift+Enter 换行'">
          <a-button
            v-if="collab.chainingHere"
            class="gcomposer-send"
            type="primary"
            shape="circle"
            @click="collab.abort()"
          >
            <template #icon><PauseOutlined /></template>
          </a-button>
          <a-button
            v-else
            class="gcomposer-send"
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

.gcomposer-toolbar {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 8px;
  padding: 4px 2px 0 4px;
}

.gcomposer-model {
  min-width: 128px;
  max-width: 220px;
}

.gcomposer-model :deep(.ant-select-selector) {
  font-size: 12px;
}

.gcomposer-send {
  flex-shrink: 0;
}
</style>
