<script setup lang="ts">
import { t } from '@renderer/i18n'
import { App } from 'antdv-next'
import { ExportOutlined } from '@antdv-next/icons'
import { useArtifactStore } from '@renderer/stores/artifact'

// 走 App.useApp() 而不是静态导入:静态那份取不到 ConfigProvider 的
// 上下文,主题、语言、z-index 全用的是默认值
const { message } = App.useApp()

/**
 * 导出当前版本。
 *
 * 放在项目标题那一行,而不是预览/代码的头部:导出的是**整个项目的产物**,
 * 跟你当下在看预览还是看代码无关。挂在 tab 头上会让人以为"导出的是这个
 * tab 里的东西"。
 */

const store = useArtifactStore()

async function doExport(): Promise<void> {
  const dir = await store.exportCurrent()
  if (dir) message.success(t('已导出到 {0}', dir))
}
</script>

<template>
  <a-button
    size="small"
    :disabled="!store.currentId || store.streamingFiles || store.loading"
    :loading="store.exporting"
    @click="doExport"
  >
    <template #icon><ExportOutlined /></template>
    {{ t('导出') }}
  </a-button>
</template>
