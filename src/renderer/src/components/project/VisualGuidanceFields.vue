<script setup lang="ts">
import { App } from 'antdv-next'
import { currentLanguage, t, uiMessage } from '@renderer/i18n'
import { decodeDesignDocument, MAX_DESIGN_DOCUMENT_BYTES } from '@shared/visual-guidance'
import type { VisualStylePriority } from '@shared/types'

const styleBrief = defineModel<string>('styleBrief', { required: true })
const designDocument = defineModel<string>('designDocument', { required: true })
const priority = defineModel<VisualStylePriority>('priority', { required: true })
const emit = defineEmits<{ loading: [value: boolean] }>()
const { message } = App.useApp()
const input = ref<HTMLInputElement | null>(null)
const filename = ref('')
const loading = ref(false)
let generation = 0

watch(designDocument, () => {
  if (!designDocument.value) filename.value = ''
})
onBeforeUnmount(() => {
  generation++
})

async function importFile(event: Event): Promise<void> {
  const target = event.target as HTMLInputElement
  const file = target.files?.[0]
  target.value = ''
  if (!file) return
  const current = ++generation
  loading.value = true
  emit('loading', true)
  try {
    if (file.size > MAX_DESIGN_DOCUMENT_BYTES)
      throw new Error(t('messages.designMdMustNotExceed64Kib'))
    const content = decodeDesignDocument(
      file.name,
      new Uint8Array(await file.arrayBuffer()),
      currentLanguage()
    )
    if (current !== generation) return
    designDocument.value = content
    filename.value = file.name
  } catch (error) {
    if (current === generation) message.error(uiMessage((error as Error).message))
  } finally {
    if (current === generation) {
      loading.value = false
      emit('loading', false)
    }
  }
}
</script>

<template>
  <a-form-item
    :label="t('common.visualStyle')"
    :extra="t('messages.describeColorsLightDarkModeDensity')"
  >
    <a-textarea
      v-model:value="styleBrief"
      :rows="4"
      :placeholder="t('messages.eGDarkIndustrialStyleHigh')"
    />
  </a-form-item>
  <a-form-item
    :label="t('common.designMdOptional')"
    :extra="t('messages.visualRulesOnlySkillSelectionWorkflows')"
  >
    <input ref="input" type="file" accept=".md" hidden @change="importFile" />
    <a-space wrap>
      <a-button :loading="loading" @click="input?.click()">{{
        designDocument ? t('common.replaceFile') : t('common.importDesignMd')
      }}</a-button>
      <span v-if="designDocument">{{ filename || 'DESIGN.md' }}</span>
      <a-button v-if="designDocument" :disabled="loading" @click="designDocument = ''">{{
        t('common.remove')
      }}</a-button>
    </a-space>
    <pre v-if="designDocument" class="design-preview">{{ designDocument }}</pre>
  </a-form-item>
  <a-form-item
    v-if="designDocument"
    :label="t('messages.whenVisualRulesConflictPrefer')"
    :extra="t('messages.compatibleRulesAreCombinedExplicitRequests')"
  >
    <a-segmented
      v-model:value="priority"
      :options="[
        { label: t('common.visualStyleFirst'), value: 'styleBrief' },
        { label: t('common.designMdFirst'), value: 'designDocument' }
      ]"
    />
  </a-form-item>
</template>

<style scoped>
.design-preview {
  max-height: 200px;
  overflow-y: auto;
  overscroll-behavior: contain;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  margin: 12px 0 0;
  padding: 12px;
  border: 1px solid var(--ant-color-border, #d9d9d9);
  border-radius: 6px;
  font-size: 12px;
}
</style>
