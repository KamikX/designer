<script setup lang="ts">
import { theme } from 'antdv-next'
import { useArtifactStore } from '@renderer/stores/artifact'
import FileTree from './FileTree.vue'
import CodeViewer from './CodeViewer.vue'
import VersionBar from './VersionBar.vue'
import PreviewPane from './PreviewPane.vue'
import type { Project } from '@shared/types'

const props = defineProps<{ project: Project }>()

/** 右侧工作区:预览 / 代码 两个 tab + 版本条。预览 iframe 在 M5 接入。 */

const { token } = theme.useToken()
const store = useArtifactStore()
const activeTab = ref('preview')

watch(
  () => props.project.id,
  (id) => store.loadForProject(id),
  { immediate: true }
)

// 流式开始切到代码视图看文件长出来;生成完自动切回预览看效果
watch(
  () => store.streamingFiles,
  (streaming, was) => {
    if (streaming) activeTab.value = 'code'
    else if (was) activeTab.value = 'preview'
  }
)

const empty = computed(() => store.artifacts.length === 0 && !store.streamingFiles)
</script>

<template>
  <div class="workspace" :style="{ background: token.colorBgContainer, borderRadius: '8px' }">
    <a-flex align="center" justify="space-between" class="workspace-header">
      <a-tabs v-model:active-key="activeTab" size="small" style="flex: 1">
        <a-tab-pane key="preview" tab="预览" />
        <a-tab-pane key="code" tab="代码" />
      </a-tabs>
      <VersionBar />
    </a-flex>

    <div class="workspace-body">
      <a-empty
        v-if="empty"
        description="生成设计稿后,这里会出现文件树与预览"
        style="margin-top: 120px"
      />

      <template v-else-if="activeTab === 'code'">
        <div class="code-layout">
          <div class="file-tree">
            <FileTree />
          </div>
          <div class="code-view">
            <CodeViewer />
          </div>
        </div>
      </template>

      <template v-else>
        <PreviewPane />
      </template>
    </div>
  </div>
</template>

<style scoped>
.workspace {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  padding: 0 12px 12px;
}

.workspace-header {
  flex-shrink: 0;
  gap: 12px;
}

.workspace-header :deep(.ant-tabs-nav) {
  margin-bottom: 0;
}

.workspace-body {
  flex: 1;
  min-height: 0;
  overflow: hidden;
  padding-top: 10px;
}

.code-layout {
  display: flex;
  gap: 10px;
  height: 100%;
  min-height: 0;
}

.file-tree {
  width: 200px;
  flex-shrink: 0;
  overflow: auto;
}

.code-view {
  flex: 1;
  min-width: 0;
  min-height: 0;
}
</style>
