<script setup lang="ts">
import { App, theme } from 'antdv-next'
import { AppstoreAddOutlined } from '@antdv-next/icons'
import { useArtifactStore } from '@renderer/stores/artifact'
import { useProjectStore } from '@renderer/stores/project'
import FileTree from './FileTree.vue'
import CodeViewer from './CodeViewer.vue'
import PreviewPane from './PreviewPane.vue'
import type { PreviewLib, Project } from '@shared/types'

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

/* ---------------- 依赖包(创建后可改) ---------------- */

const { message } = App.useApp()
const projectStore = useProjectStore()

/** 与 CreateProjectModal 同一份清单;目前只有 vue3 栈有可加载的依赖 */
const LIB_OPTIONS: { value: PreviewLib; label: string; hint: string }[] = [
  { value: 'antdv-next', label: 'antdv-next', hint: '组件库本体' },
  { value: '@antdv-next/icons', label: '@antdv-next/icons', hint: '配套图标库' }
]

/**
 * 勾选状态的本地乐观副本。
 *
 * 不直接读 props.project.libs:那要等 IPC 往返、整个 project 对象替换后才
 * 更新,checkbox 点下去会先翻转再被旧值拍回去,看起来就是"取消不掉"。
 * 点击立即改本地副本,落库失败再回滚。
 */
const libDraft = ref<PreviewLib[]>([])
watch(
  () => props.project.libs,
  (libs) => (libDraft.value = [...(libs ?? [])]),
  { immediate: true }
)

async function toggleLib(value: PreviewLib): Promise<void> {
  const before = [...libDraft.value]
  const next = new Set(libDraft.value)
  if (next.has(value)) next.delete(value)
  else {
    next.add(value)
    // 图标包依赖组件库本体的场景占绝大多数,勾图标顺手带上本体
    if (value === '@antdv-next/icons') next.add('antdv-next')
  }
  libDraft.value = [...next]
  try {
    await projectStore.setLibs(props.project.id, libDraft.value)
    // 引导 HTML 按项目当前状态生成,不刷预览看不到变化;
    // 提示词的变化则在下一轮对话自然生效
    store.previewEpoch++
    message.success('依赖包已更新,预览已刷新;AI 从下一轮开始按新依赖生成')
  } catch (err) {
    libDraft.value = before
    message.error(err instanceof Error ? err.message : String(err))
  }
}
</script>

<template>
  <div class="workspace" :style="{ background: token.colorBgContainer, borderRadius: '8px' }">
    <div class="workspace-header">
      <a-segmented
        v-model:value="activeTab"
        size="small"
        :options="[
          { label: '预览', value: 'preview' },
          { label: '代码', value: 'code' }
        ]"
      />

      <!-- 依赖包创建后也能改:老项目不用重建就能用上组件库 -->
      <a-popover v-if="project.stack === 'vue3'" trigger="click" placement="bottomRight">
        <template #content>
          <div class="libs-pop">
            <div class="libs-pop-title">依赖包(预览环境自动加载)</div>
            <label v-for="opt in LIB_OPTIONS" :key="opt.value" class="libs-pop-row">
              <a-checkbox :checked="libDraft.includes(opt.value)" @change="toggleLib(opt.value)" />
              <span class="libs-pop-name">{{ opt.label }}</span>
              <span class="libs-pop-meta" :style="{ color: token.colorTextTertiary }">
                {{ opt.hint }}
              </span>
            </label>
          </div>
        </template>
        <a-tooltip title="依赖包">
          <button class="libs-btn" :style="{ color: token.colorTextSecondary }" type="button">
            <AppstoreAddOutlined />
            <span
              v-if="libDraft.length"
              class="libs-badge"
              :style="{ background: token.colorPrimary }"
            >
              {{ libDraft.length }}
            </span>
          </button>
        </a-tooltip>
      </a-popover>
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
  display: flex;
  align-items: center;
  justify-content: space-between;
  /* 原来的高度由 tabs 的内边距撑出来;换成紧凑的 segmented 后自己补 */
  padding: 8px 8px 4px;
}

.libs-btn {
  position: relative;
  display: inline-flex;
  align-items: center;
  border: none;
  background: none;
  padding: 4px 6px;
  cursor: pointer;
  font-size: 14px;
  border-radius: 6px;
}

.libs-badge {
  position: absolute;
  top: -2px;
  right: -4px;
  min-width: 14px;
  height: 14px;
  border-radius: 7px;
  color: #fff;
  font-size: 10px;
  line-height: 14px;
  text-align: center;
  padding: 0 3px;
}

.libs-pop {
  width: 260px;
}

.libs-pop-title {
  font-size: 12px;
  font-weight: 600;
  opacity: 0.75;
  margin-bottom: 8px;
}

.libs-pop-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 0;
  cursor: pointer;
  font-size: 13px;
}

.libs-pop-meta {
  font-size: 12px;
  margin-left: auto;
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
