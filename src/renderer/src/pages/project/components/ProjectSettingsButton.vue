<script setup lang="ts">
import { App, theme } from 'antdv-next'
import { SettingOutlined } from '@antdv-next/icons'
import { useProjectStore } from '@renderer/stores/project'
import { DEFAULT_TOOL_CALL_LIMIT } from '@shared/limits'
import type { Project } from '@shared/types'

/**
 * 项目级运行设置。
 *
 * 目前只有一项:单轮工具调用上限。它是项目属性而不是会话属性——"改一版
 * 落地页"和"重构一个后台管理系统"需要的次数差一个数量级,而同一个项目
 * 的每一轮大体是同一个量级。
 */

const props = defineProps<{ project: Project }>()

const { token } = theme.useToken()
const { message } = App.useApp()
const store = useProjectStore()

const open = ref(false)
/** 空串 = 跟随全局。用 string 而不是 number|null:输入框清空时要能表达"没设" */
const draft = ref('')
const globalLimit = ref(window.api.initialConfig.toolCallLimit ?? DEFAULT_TOOL_CALL_LIMIT)

const saved = computed(() => props.project.settings?.toolCallLimit)

watch(
  () => saved.value,
  (value) => (draft.value = typeof value === 'number' ? String(value) : ''),
  { immediate: true }
)

// 全局值可能在设置页刚被改过,每次打开弹层重新取一遍再显示"跟随全局(N)"
watch(open, async (isOpen) => {
  if (!isOpen) return
  globalLimit.value = (await window.api.config.read()).toolCallLimit ?? DEFAULT_TOOL_CALL_LIMIT
})

const hint = computed(() => {
  if (draft.value.trim() === '') return `跟随全局设置(${globalLimit.value || '不限'})`
  const value = Number(draft.value)
  if (!Number.isFinite(value) || value < 0) return '请填 0 或正整数'
  return value === 0 ? '不限次数,只剩上下文预算这一条熔断' : `本项目每轮最多 ${value} 次工具调用`
})

async function save(): Promise<void> {
  const raw = draft.value.trim()
  const value = raw === '' ? null : Math.floor(Number(raw))
  if (value !== null && (!Number.isFinite(value) || value < 0)) {
    message.warning('请填 0 或正整数,留空表示跟随全局')
    return
  }
  await store.setToolCallLimit(props.project.id, value)
  open.value = false
  message.success('已保存,下一轮对话生效')
}
</script>

<template>
  <a-popover v-model:open="open" trigger="click" placement="bottomRight">
    <template #content>
      <div class="proj-set">
        <div class="proj-set-title">单轮工具调用上限</div>
        <a-space-compact>
          <a-input
            v-model:value="draft"
            size="small"
            style="width: 132px"
            placeholder="留空跟随全局"
            @press-enter="save"
          />
          <a-button size="small" type="primary" @click="save">保存</a-button>
        </a-space-compact>
        <div class="proj-set-hint" :style="{ color: token.colorTextTertiary }">{{ hint }}</div>
        <div class="proj-set-hint" :style="{ color: token.colorTextTertiary }">
          复杂改动需要更多次数;填 0 不限,单轮会更慢更贵。
        </div>
      </div>
    </template>
    <a-tooltip title="项目设置">
      <a-button type="text" size="small">
        <template #icon><SettingOutlined /></template>
      </a-button>
    </a-tooltip>
  </a-popover>
</template>

<style scoped>
/* 弹层封顶高度内部滚动:硬约定,别把页面顶出滚动条 */
.proj-set {
  width: 240px;
  max-height: 60vh;
  overflow-y: auto;
  overscroll-behavior: contain;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.proj-set-title {
  font-size: 12px;
  font-weight: 600;
}

.proj-set-hint {
  font-size: 12px;
  line-height: 1.5;
}
</style>
