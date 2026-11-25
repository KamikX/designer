<script setup lang="ts">
import { t, uiMessage } from '@renderer/i18n'
import { App, theme } from 'antdv-next'
import { DeleteOutlined, FolderOpenOutlined, PlusOutlined } from '@antdv-next/icons'
import { useChatStore } from '@renderer/stores/chat'
import type { RootScope, WorkspaceRoot } from '@shared/types'

/**
 * 本地目录授权入口。
 *
 * 这是本地文件能力的**唯一开关**,所以它必须显眼、可撤销、并且说清楚
 * 授权之后 AI 能做什么——用户点"选择目录"时应当完全明白自己让出了什么。
 * 一个都没授权时,主进程连本地文件工具都不注册。
 */

// 收 scope 而不是 projectId:同一个组件要同时服务设计工作台和纯聊天
const props = defineProps<{ scope: RootScope }>()

const { token } = theme.useToken()
const { message, modal } = App.useApp()
const chatStore = useChatStore()

const roots = ref<WorkspaceRoot[]>([])
const granting = ref(false)

watch(
  () => props.scope,
  async (scope) => {
    roots.value = scope ? await window.api.workspace.list(scope) : []
  },
  { immediate: true, deep: true }
)

// 用户在对话里直接写路径时,主进程会当场授权;这里跟着刷新,
// 让"我刚那句话放开了什么"立刻可见、也立刻可撤销
watch(
  () => chatStore.lastGrantedRoots,
  (added) => {
    for (const root of added) {
      if (!roots.value.some((r) => r.id === root.id)) roots.value.push(root)
    }
  }
)

async function grant(): Promise<void> {
  granting.value = true
  try {
    const added = await window.api.workspace.grant(props.scope)
    if (!added) return
    if (!roots.value.some((r) => r.id === added.id)) roots.value.push(added)
    message.success(t('messages.accessGrantedTo', added.name))
  } catch (err) {
    message.error(uiMessage(err instanceof Error ? err.message : String(err)))
  } finally {
    granting.value = false
  }
}

function revoke(root: WorkspaceRoot): void {
  modal.confirm({
    get title() {
      return t('messages.revokeAccessTo', root.name)
    },
    content: t('messages.aiWillNoLongerBeAbleToReadFilesInThisDirectory'),
    okType: 'danger',
    onOk: async () => {
      await window.api.workspace.revoke(root.id)
      roots.value = roots.value.filter((r) => r.id !== root.id)
    }
  })
}
</script>

<template>
  <a-popover trigger="click" placement="topLeft">
    <template #content>
      <div class="roots-pop">
        <div class="roots-title">{{ t('messages.letAiReferenceALocalProject') }}</div>
        <div class="roots-hint" :style="{ color: token.colorTextTertiary }">
          {{ t('messages.grantAccessSoAiCanBrowse') }}
          <br />
          {{ t('messages.enteringAPathInTheConversation') }}
        </div>

        <div
          v-if="roots.length === 0"
          class="roots-empty"
          :style="{ color: token.colorTextQuaternary }"
        >
          {{ t('messages.noDirectoriesAuthorizedYet') }}
        </div>
        <div
          v-for="root in roots"
          :key="root.id"
          class="roots-row"
          :style="{ borderColor: token.colorBorderSecondary }"
        >
          <div class="roots-info">
            <div class="roots-name">{{ root.name }}</div>
            <div class="roots-path" :style="{ color: token.colorTextTertiary }">
              {{ root.path }}
            </div>
          </div>
          <a-button type="text" size="small" danger @click="revoke(root)">
            <template #icon><DeleteOutlined /></template>
          </a-button>
        </div>

        <a-button block size="small" :loading="granting" style="margin-top: 8px" @click="grant">
          <template #icon><PlusOutlined /></template>
          {{ t('common.selectDirectory') }}
        </a-button>
      </div>
    </template>

    <!-- 与输入框工具条上的 MCP / 技能同款,它们是同一类东西:
         "这次对话给 AI 看什么"。工具条只放图标,名字进 tooltip -->
    <a-tooltip :title="t('common.localDirectoryAccess')">
      <button class="toolbox-btn" :style="{ color: token.colorTextSecondary }" type="button">
        <FolderOpenOutlined />
        <span v-if="roots.length" class="toolbox-badge tabular">{{ roots.length }}</span>
      </button>
    </a-tooltip>
  </a-popover>
</template>

<style scoped>
.roots-pop {
  width: 320px;
}

.roots-title {
  font-size: 13px;
  font-weight: 600;
  margin-bottom: 6px;
}

.roots-hint {
  font-size: 12px;
  line-height: 1.7;
  margin-bottom: 10px;
}

.roots-empty {
  font-size: 12px;
  text-align: center;
  padding: 10px 0;
}

.roots-row {
  display: flex;
  align-items: center;
  gap: 8px;
  border: 1px solid transparent;
  border-radius: 8px;
  padding: 6px 8px;
}

.roots-row + .roots-row {
  margin-top: 4px;
}

.roots-info {
  min-width: 0;
  flex: 1;
}

.roots-name {
  font-size: 12px;
  font-weight: 500;
}

.roots-path {
  font-size: 11px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  direction: rtl;
  text-align: left;
}

/* 与 Composer 工具条上的按钮保持一致。样式是 scoped 的,各写一份,
   这点重复换来两个组件互不牵连 */
.toolbox-btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  /* 不加这个,"目录""技能"会在窄面板里被拆成竖排的单字 */
  white-space: nowrap;
  flex-shrink: 0;
  border: none;
  background: none;
  cursor: pointer;
  font-size: 12px;
  padding: 4px 8px;
  border-radius: 8px;
  transition: background 0.15s;
}

.toolbox-btn:hover {
  background: rgba(128, 128, 128, 0.12);
}

/*
 * 计数徽标走中性填充,不上主色。
 *
 * 这一屏的规矩是:**开着的模式**才配主色(联网开关、标注模式),
 * "勾了几个"只是一个数。四个工具按钮各挂一颗蓝点的时候,整块面板里
 * 最亮的像素说的是"你授权了 2 个目录",而那是最不需要被看见的一句话。
 */
.toolbox-badge {
  min-width: 16px;
  height: 16px;
  border-radius: var(--radius-pill);
  /* 实心的中性灰配面板色的字:没有主色也一眼是个"计数芯片",
     用半透明填充的话圆形边界看不出来,数字像是浮在图标旁边 */
  background: var(--text-soft);
  color: var(--bg-panel);
  font-size: 10px;
  line-height: 16px;
  text-align: center;
  padding: 0 4px;
}
</style>
