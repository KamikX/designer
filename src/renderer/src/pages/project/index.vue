<script setup lang="ts">
import { useRoute, useRouter } from 'vue-router'
import { useProjectStore } from '@renderer/stores/project'
import { ArrowLeftOutlined } from '@antdv-next/icons'
import ChatPanel from './components/ChatPanel.vue'
import WorkspacePane from './components/WorkspacePane.vue'

/**
 * 项目工作台:左对话 / 右预览与代码,中间分割条可拖拽调宽。
 * 左右各自滚动,整页不滚——对话与预览是两条独立的阅读流。
 */

const route = useRoute()
const router = useRouter()
const store = useProjectStore()

const projectId = computed(() => String(route.params.id))
const missing = ref(false)

watch(
  projectId,
  async (id) => {
    const project = await store.open(id)
    missing.value = !project
  },
  { immediate: true }
)

const STACK_LABEL: Record<string, string> = { html: 'HTML', vue3: 'Vue 3', react: 'React' }
</script>

<template>
  <a-result v-if="missing" status="404" title="项目不存在" sub-title="它可能已被删除">
    <template #extra>
      <a-button type="primary" @click="router.push('/')">回项目列表</a-button>
    </template>
  </a-result>

  <div v-else class="workbench">
    <a-flex align="center" :gap="8" class="workbench-header">
      <a-button type="text" size="small" @click="router.push('/')">
        <template #icon><ArrowLeftOutlined /></template>
      </a-button>
      <span style="font-weight: 600">{{ store.current?.name }}</span>
      <a-tag v-if="store.current" style="margin-left: 4px">
        {{ STACK_LABEL[store.current.stack] }}
      </a-tag>
    </a-flex>

    <a-splitter class="workbench-body">
      <a-splitter-panel :default-size="440" :min="340" :max="720" class="chat-pane">
        <ChatPanel v-if="store.current" :project="store.current" />
      </a-splitter-panel>
      <a-splitter-panel :min="480" class="workspace-pane">
        <WorkspacePane v-if="store.current" :project="store.current" />
      </a-splitter-panel>
    </a-splitter>
  </div>
</template>

<style scoped>
.workbench {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}

.workbench-header {
  flex-shrink: 0;
  padding-bottom: 8px;
}

.workbench-body {
  flex: 1;
  min-height: 0;
}

.chat-pane {
  padding-right: 12px;
  display: flex;
  flex-direction: column;
  min-height: 0;
}

.workspace-pane {
  padding-left: 12px;
  min-height: 0;
}
</style>
