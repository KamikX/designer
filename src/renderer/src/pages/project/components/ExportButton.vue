<script setup lang="ts">
import { t, uiMessage } from '@renderer/i18n'
import { App } from 'antdv-next'
import { ExportOutlined } from '@antdv-next/icons'
import { useArtifactStore } from '@renderer/stores/artifact'
import { useProjectStore } from '@renderer/stores/project'
import { useChatStore } from '@renderer/stores/chat'

const { message } = App.useApp()
const store = useArtifactStore()
const projects = useProjectStore()
const chat = useChatStore()
const open = ref(false)
const exporting = ref(false)
const busy = computed(() =>
  Object.values(chat.streams).some((s) => s.projectId === projects.current?.id)
)
const disabled = computed(
  () =>
    store.loading ||
    busy.value ||
    exporting.value ||
    store.exporting ||
    store.projectId !== projects.current?.id
)

async function doExport(packageExport: boolean): Promise<void> {
  const projectId = projects.current?.id
  if (!projectId || disabled.value) return
  const selectedArtifactId = store.currentId || null
  open.value = false
  exporting.value = true
  try {
    const path = packageExport
      ? await window.api.project.exportPackage({ projectId, selectedArtifactId })
      : await store.exportCurrent()
    if (path) message.success(t('已导出到 {0}', path))
  } catch (error) {
    message.error(uiMessage(error instanceof Error ? error.message : String(error)))
  } finally {
    exporting.value = false
  }
}
</script>

<template>
  <a-popover v-model:open="open" trigger="click" placement="bottomRight">
    <template #content>
      <div class="export-options">
        <a-button :disabled="disabled || !store.currentId" @click="doExport(false)">{{
          t('导出源文件')
        }}</a-button>
        <a-button :disabled="disabled" @click="doExport(true)">{{ t('导出项目') }}</a-button>
      </div>
    </template>
    <a-button size="small" :disabled="disabled" :loading="exporting || store.exporting">
      <template #icon><ExportOutlined /></template>
      {{ t('导出') }}
    </a-button>
  </a-popover>
</template>

<style scoped>
.export-options {
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-height: 240px;
  overflow-y: auto;
  overscroll-behavior: contain;
}
</style>
