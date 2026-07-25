<script setup lang="ts">
import { useRoute, useRouter } from 'vue-router'
import { useProjectStore } from '@renderer/stores/project'
import { ArrowLeftOutlined } from '@antdv-next/icons'
import ChatPanel from './components/ChatPanel.vue'
import WorkspacePane from './components/WorkspacePane.vue'
import ExportButton from './components/ExportButton.vue'

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
      <!-- 顶到最右:导出是项目级动作,和标题同级 -->
      <ExportButton v-if="store.current" style="margin-left: auto" />
    </a-flex>

    <!-- flex 收在行内:<a-splitter> 的 class 同样带不上 scoped 的 data-v,
         写成 .workbench-body{} 是不会生效的 -->
    <a-splitter class="workbench-body" style="flex: 1; min-height: 0">
      <!-- 面板里再套一层自己的 div:样式只能挂在这层上,原因见下方注释 -->
      <a-splitter-panel :default-size="360" :min="300" :max="720">
        <div class="chat-pane">
          <ChatPanel v-if="store.current" :project="store.current" />
        </div>
      </a-splitter-panel>
      <a-splitter-panel :min="480">
        <div class="workspace-pane">
          <WorkspacePane v-if="store.current" :project="store.current" />
        </div>
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
  padding: 0 var(--page-pad) var(--page-pad);
}

.workbench-header {
  flex-shrink: 0;
  padding-bottom: 8px;
}

/*
 * ⚠️ 样式绝不能写在 <a-splitter-panel> 上,必须写在它里面那层自己的 div 上。
 *
 * Splitter 不会渲染我们写的 <a-splitter-panel>,而是取出 props 后在**它自己的**
 * render 里重建面板(Splitter.js: createVNode(InternalPanel, ...))。class 会被
 * 带过去,scoped 样式依赖的 data-v 属性不会——于是 `.chat-pane[data-v-x]` 这类
 * 选择器永远匹配不上。
 *
 * 这种失效**完全静默**:CSS 语法正确、构建通过、类名在 DOM 上也看得见,只是
 * 多了个属性条件匹配不上。我在这上面连着栽过两次(面板间距、文件树间距),
 * 两次都以为改好了。所以现在一律多包一层 div。
 */
.chat-pane,
.workspace-pane {
  height: 100%;
  min-height: 0;
}

.chat-pane {
  /* 左边距来自 .workbench 的 padding-left,取同一个值,输入框才左右对称 */
  padding-right: var(--page-pad);
}

.workspace-pane {
  /*
   * 只取一半。这一侧不需要和 .chat-pane 对等:工作区是一张有底色、有圆角的
   * 卡片,边界本来就看得见;而对话侧是裸内容,得靠留白把它和卡片分开。
   * 两边都给满的话中间那条空白就过宽了。
   */
  padding-left: calc(var(--page-pad) / 2);
}
</style>
