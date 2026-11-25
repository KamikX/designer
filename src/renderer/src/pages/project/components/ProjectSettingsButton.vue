<script setup lang="ts">
import VisualGuidanceFields from '@renderer/components/project/VisualGuidanceFields.vue'
import { t, uiMessage } from '@renderer/i18n'
import { App, theme } from 'antdv-next'
import { SettingOutlined } from '@antdv-next/icons'
import { useProjectStore } from '@renderer/stores/project'
import { DEFAULT_TOOL_CALL_LIMIT } from '@shared/limits'
import type { Project, VisualGuidance } from '@shared/types'

const props = defineProps<{ project: Project }>()

const { token } = theme.useToken()
const { message } = App.useApp()
const store = useProjectStore()

const open = ref(false)
const saving = ref(false)
const importing = ref(false)
const description = ref('')
const codeInstructions = ref('')
const guidance = reactive<VisualGuidance>({
  styleBrief: '',
  designDocument: '',
  visualStylePriority: 'styleBrief'
})
/** 空串 = 跟随全局。用 string 而不是 number|null:输入框清空时要能表达"没设" */
const draft = ref('')
const globalLimit = ref(window.api.initialConfig.toolCallLimit ?? DEFAULT_TOOL_CALL_LIMIT)

const saved = computed(() => props.project.settings?.toolCallLimit)

watch(
  () => props.project.id,
  () => {
    open.value = false
  }
)

// 全局值可能在设置页刚被改过,每次打开弹层重新取一遍再显示"跟随全局(N)"
watch(open, async (isOpen) => {
  if (!isOpen) return
  importing.value = false
  description.value = props.project.description
  codeInstructions.value = props.project.codeInstructions ?? ''
  Object.assign(guidance, {
    styleBrief: props.project.styleBrief,
    designDocument: props.project.designDocument ?? '',
    visualStylePriority: props.project.visualStylePriority ?? 'styleBrief'
  })
  draft.value = typeof saved.value === 'number' ? String(saved.value) : ''
  globalLimit.value = (await window.api.config.read()).toolCallLimit ?? DEFAULT_TOOL_CALL_LIMIT
})

const hint = computed(() => {
  if (draft.value.trim() === '')
    return t('messages.useGlobalSetting', globalLimit.value || t('common.unlimited'))
  const value = Number(draft.value)
  if (!Number.isFinite(value) || value < 0) return t('messages.enter0OrAPositiveInteger')
  return value === 0
    ? t('messages.unlimitedCallsOnlyTheContextBudgetLimitApplies')
    : t('messages.upToToolCallsPerTurnForThisProject', value)
})

async function save(): Promise<void> {
  const raw = draft.value.trim()
  const value = raw === '' ? null : Math.floor(Number(raw))
  if (value !== null && (!Number.isFinite(value) || value < 0)) {
    message.warning(t('messages.enter0OrAPositiveIntegerOrLeaveBlankToUseTheGlobalSetting'))
    return
  }
  if (saving.value || importing.value) return
  saving.value = true
  const projectId = props.project.id
  try {
    await store.setDescription(projectId, description.value)
    await store.setCodeInstructions(projectId, codeInstructions.value)
    await store.setVisualGuidance(projectId, { ...guidance })
    await store.setToolCallLimit(projectId, value)
    open.value = false
    message.success(t('messages.savedForTheNextTurn'))
  } catch (error) {
    message.error(uiMessage((error as Error).message))
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <a-tooltip :title="t('common.projectSettings')">
    <a-button type="text" size="small" @click="open = true">
      <template #icon><SettingOutlined /></template>
    </a-button>
  </a-tooltip>
  <a-modal
    v-model:open="open"
    :title="t('common.projectSettings')"
    :width="600"
    :confirm-loading="saving"
    :ok-button-props="{ disabled: importing }"
    :ok-text="t('common.save')"
    @ok="save"
  >
    <a-form layout="vertical" class="proj-set">
      <a-form-item :label="t('common.projectDescription')">
        <a-textarea
          v-model:value="description"
          :rows="3"
          :placeholder="t('messages.describeTheProjectForTheAi')"
        />
      </a-form-item>
      <a-form-item
        :label="t('common.codeGenerationRules')"
        :extra="t('messages.appliedToEveryGenerationStartingWith')"
      >
        <a-textarea
          v-model:value="codeInstructions"
          :rows="6"
          :placeholder="t('messages.forExampleValidateFormsWithZod')"
        />
      </a-form-item>
      <VisualGuidanceFields
        v-if="open"
        v-model:style-brief="guidance.styleBrief"
        v-model:design-document="guidance.designDocument"
        v-model:priority="guidance.visualStylePriority"
        @loading="importing = $event"
      />
      <a-form-item :label="t('messages.toolCallLimitPerTurn')" :extra="hint">
        <a-input v-model:value="draft" :placeholder="t('messages.leaveBlankToUseGlobalSetting')" />
        <div :style="{ color: token.colorTextTertiary }">
          {{ t('messages.complexChangesNeedMoreCallsSet') }}
        </div>
      </a-form-item>
    </a-form>
  </a-modal>
</template>

<style scoped>
.proj-set {
  max-height: calc(80vh - 120px);
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: 8px 6px 0 2px;
}
</style>
