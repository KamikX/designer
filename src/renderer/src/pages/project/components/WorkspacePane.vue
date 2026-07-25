<script setup lang="ts">
import { theme } from 'antdv-next'
import { useArtifactStore } from '@renderer/stores/artifact'
import FileTree from './FileTree.vue'
import CodeViewer from './CodeViewer.vue'
import PreviewPane from './PreviewPane.vue'
import type { Project } from '@shared/types'

const props = defineProps<{ project: Project }>()

/** 右侧工作区:预览 / 代码 两个 tab。导出和目录授权都挪走了——
 * 前者属于整个项目(在标题行),后者属于对话上下文(在输入框工具条)。 */

const { token } = theme.useToken()
const store = useArtifactStore()
const activeTab = ref('preview')

// 文件树宽度持久化:拖过一次之后每次进来都是自己调好的宽度。
// 默认给得偏窄——设计稿通常就几个文件,树再宽也是空的,那点宽度
// 留给代码区更值。
// key 带版本号:useStorage 首次读取就会把默认值写进 localStorage,
// 不换 key 的话老用户永远停在旧默认值上,改了也看不见
const treeWidth = useStorage('designer:code-tree-width-v2', 168)

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
    <div class="workspace-header">
      <a-tabs v-model:active-key="activeTab" size="small">
        <a-tab-pane key="preview" tab="预览" />
        <a-tab-pane key="code" tab="代码" />
      </a-tabs>
    </div>

    <div class="workspace-body">
      <a-empty
        v-if="empty"
        description="生成设计稿后,这里会出现文件树与预览"
        style="margin-top: 120px"
      />

      <template v-else-if="activeTab === 'code'">
        <a-splitter
          class="code-layout"
          style="height: 100%; min-height: 0"
          @resize="(sizes: number[]) => (treeWidth = sizes[0])"
        >
          <!-- 同样要多包一层:样式挂在 <a-splitter-panel> 上不会生效,
               原因见 pages/project/index.vue 里的说明 -->
          <a-splitter-panel :default-size="treeWidth" :min="120" :max="360">
            <div class="file-tree"><FileTree /></div>
          </a-splitter-panel>
          <a-splitter-panel :min="320">
            <div class="code-view"><CodeViewer /></div>
          </a-splitter-panel>
        </a-splitter>
      </template>

      <template v-else>
        <PreviewPane />
      </template>
    </div>
  </div>
</template>

<style scoped>
/* 与对话面板之间的间距由外层的 .workspace-pane 给,这里只管卡片内部 */
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

/*
 * block-node 让整行铺满容器:左边有树缩进撑着,右边直接顶到分割条上,
 * 选中态的色块看着就是歪的。容器给对称留白,行块两边才一样宽。
 */
.file-tree {
  height: 100%;
  /*
   * 只允许纵向滚动。横向一旦能滚,树就会被长文件名撑宽,内容冲出右边的
   * padding——那正是"padding 看起来没生效"的真相。锁死横向之后,超长的名字
   * 由 FileTree 里的省略号处理。
   */
  overflow-y: auto;
  overflow-x: hidden;
  /* 右边挨着分割条,给多一点;左边只是贴面板边 */
  padding: 0 8px 0 6px;
}

.code-view {
  height: 100%;
  min-width: 0;
  min-height: 0;
  /*
   * 只给一点点。间距主要由树那侧出:代码区左边是行号,本来就自带视觉留白,
   * 两边各给一半的话总间距就显得过宽了。右边一点不给——之前试过,代码块
   * 两侧都空出一条很难看。
   */
  padding-left: 4px;
}
</style>
