<script setup lang="ts">
import { message } from 'antdv-next'
import { ExportOutlined } from '@antdv-next/icons'
import { useArtifactStore } from '@renderer/stores/artifact'
import dayjs from 'dayjs'

/** 版本切换 + 导出。 */

const store = useArtifactStore()

const options = computed(() =>
  store.artifacts.map((a) => ({
    value: a.id,
    label: `v${a.version} · ${dayjs(a.createdAt).format('MM-DD HH:mm')}`
  }))
)

async function doExport(): Promise<void> {
  const dir = await store.exportCurrent()
  if (dir) message.success(`已导出到 ${dir}`)
}
</script>

<template>
  <a-flex align="center" :gap="8">
    <a-select
      :value="store.currentId || undefined"
      :options="options"
      size="small"
      placeholder="暂无版本"
      style="min-width: 150px"
      :disabled="store.artifacts.length === 0 || store.streamingFiles"
      @change="(v: string) => store.select(v)"
    />
    <a-button
      size="small"
      :disabled="!store.currentId || store.streamingFiles"
      :loading="store.exporting"
      @click="doExport"
    >
      <template #icon><ExportOutlined /></template>
      导出
    </a-button>
  </a-flex>
</template>
