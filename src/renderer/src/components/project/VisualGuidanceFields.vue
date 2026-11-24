<script setup lang="ts">
import { App } from 'antdv-next'
import { t, uiMessage } from '@renderer/i18n'
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
    if (file.size > MAX_DESIGN_DOCUMENT_BYTES) throw new Error(t('DESIGN.md 不能超过 64 KiB'))
    const content = decodeDesignDocument(file.name, new Uint8Array(await file.arrayBuffer()))
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
    :label="t('视觉风格（可选）')"
    :extra="
      t('可描述色彩、明暗、信息密度、字体、圆角、动效等；无视觉资料时，AI 会在首次生成前询问。')
    "
  >
    <a-textarea
      v-model:value="styleBrief"
      :rows="4"
      :placeholder="t('如：深色工业感，高信息密度，紧凑无衬线字体，卡片近直角，动效克制')"
    />
  </a-form-item>
  <a-form-item
    :label="t('DESIGN.md（可选）')"
    :extra="
      t(
        '仅用于视觉规则，不改变技能选择、工作流程或技术与可访问性要求。支持 UTF-8 .md，最大 64 KiB。'
      )
    "
  >
    <input ref="input" type="file" accept=".md" hidden @change="importFile" />
    <a-space wrap>
      <a-button :loading="loading" @click="input?.click()">{{
        designDocument ? t('替换文件') : t('导入 DESIGN.md')
      }}</a-button>
      <span v-if="designDocument">{{ filename || 'DESIGN.md' }}</span>
      <a-button v-if="designDocument" :disabled="loading" @click="designDocument = ''">{{
        t('移除')
      }}</a-button>
    </a-space>
    <pre v-if="designDocument" class="design-preview">{{ designDocument }}</pre>
  </a-form-item>
  <a-form-item
    v-if="designDocument"
    :label="t('视觉规则冲突时优先使用')"
    :extra="t('无冲突的规则会合并使用；当前对话中的明确要求优先。')"
  >
    <a-segmented
      v-model:value="priority"
      :options="[
        { label: t('Visual style 优先'), value: 'styleBrief' },
        { label: t('DESIGN.md 优先'), value: 'designDocument' }
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
