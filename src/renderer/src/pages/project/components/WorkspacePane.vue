<script setup lang="ts">
import { useCodeEdits } from '@renderer/composables/useCodeEdits'
import LibraryPicker from '@renderer/components/libraries/LibraryPicker.vue'
import { t, uiMessage } from '@renderer/i18n'
import { App, theme } from 'antdv-next'
import { AppstoreAddOutlined, FileTextOutlined } from '@antdv-next/icons'
import { useArtifactStore } from '@renderer/stores/artifact'
import { useProjectStore } from '@renderer/stores/project'
import FileTree from './FileTree.vue'
import VersionPicker from './VersionPicker.vue'
import CodeViewer from './CodeViewer.vue'
import PreviewPane from './PreviewPane.vue'
import type { SourceLocation, SourceNavigation } from './source-location'
import type { ExternalLibraryRef, PreviewLib, Project } from '@shared/types'

const props = defineProps<{ project: Project }>()

/** 右侧工作区:预览 / 代码 两个 tab。导出和目录授权都挪走了——
 * 前者属于整个项目(在标题行),后者属于对话上下文(在输入框工具条)。 */

const { token } = theme.useToken()
const store = useArtifactStore()
const activeTab = ref('preview')
const { save, discard } = useCodeEdits()
const previewActionsTarget = ref<HTMLElement | null>(null)

const sourceNavigation = ref<SourceNavigation | null>(null)

function openSource(location: SourceLocation): void {
  if (!store.files.some((file) => file.path === location.path)) return
  sourceNavigation.value = {
    ...location,
    projectId: store.projectId,
    artifactId: store.currentId
  }
  store.selectedPath = location.path
  activeTab.value = 'code'
}

watch(
  () => [props.project.id, store.currentId],
  () => (sourceNavigation.value = null),
  { flush: 'sync' }
)

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
  {
    value: 'antdv-next',
    label: 'antdv-next',
    get hint() {
      return t('common.componentLibrary')
    }
  },
  {
    value: '@antdv-next/icons',
    label: '@antdv-next/icons',
    get hint() {
      return t('common.matchingIconLibrary')
    }
  }
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
    message.success(t('messages.librariesUpdatedAndPreviewRefreshedAi'))
  } catch (err) {
    libDraft.value = before
    message.error(uiMessage(err instanceof Error ? err.message : String(err)))
  }
}
const externalSaving = ref(false)
async function saveExternalLibraries(refs: ExternalLibraryRef[]): Promise<void> {
  externalSaving.value = true
  try {
    await projectStore.setExternalLibraries(props.project.id, refs)
    store.previewEpoch++
    message.success(t('messages.librariesUpdatedAndPreviewRefreshedAi'))
  } catch (err) {
    message.error(uiMessage(String(err)))
  } finally {
    externalSaving.value = false
  }
}
</script>

<template>
  <div class="workspace" :style="{ background: token.colorBgContainer }">
    <!-- hairline-b 是 base.css 的半像素发丝线:给这条工具栏一个下边界,
         否则 segmented 像浮在代码/预览区上面,两块内容之间没有交代 -->
    <div class="workspace-header hairline-b" :class="{ 'code-mode': activeTab === 'code' }">
      <a-segmented
        v-model:value="activeTab"
        size="small"
        :options="[
          {
            get label() {
              return t('common.preview')
            },
            value: 'preview'
          },
          {
            get label() {
              return t('common.code')
            },
            value: 'code'
          }
        ]"
      />

      <div v-if="activeTab === 'code'" class="code-actions">
        <span v-if="store.dirty">{{ t('code.unsaved') }}</span>
        <a-button size="small" :disabled="!store.dirty || store.editingBlocked" @click="discard">
          {{ t('code.discard') }}
        </a-button>
        <a-button
          size="small"
          type="primary"
          :loading="store.saving"
          :disabled="!store.dirty || store.editingBlocked"
          @click="save().catch(() => {})"
        >
          {{ t('common.save') }}
        </a-button>
      </div>
      <div
        v-show="activeTab !== 'code'"
        ref="previewActionsTarget"
        class="workspace-preview-actions"
      />

      <div class="workspace-header-end">
        <VersionPicker :project-id="project.id" />

        <!-- 依赖包创建后也能改:老项目不用重建就能用上组件库 -->
        <a-popover v-if="project.stack !== 'html'" trigger="click" placement="bottomRight">
          <template #content>
            <div class="libs-pop">
              <div class="libs-pop-title">
                {{ t('messages.librariesLoadedAutomaticallyInPreview') }}
              </div>
              <label
                v-for="opt in project.stack === 'vue3' ? LIB_OPTIONS : []"
                :key="opt.value"
                class="libs-pop-row"
              >
                <a-checkbox
                  :checked="libDraft.includes(opt.value)"
                  @change="toggleLib(opt.value)"
                />
                <span class="libs-pop-name">{{ opt.label }}</span>
                <span class="libs-pop-meta" :style="{ color: token.colorTextTertiary }">
                  {{ opt.hint }}
                </span>
              </label>
              <LibraryPicker
                :key="project.id"
                :model-value="project.externalLibraries ?? []"
                :disabled="externalSaving"
                :stack="project.stack"
                @update:model-value="saveExternalLibraries"
              />
            </div>
          </template>
          <a-tooltip :title="t('common.libraries')">
            <button class="libs-btn" :style="{ color: token.colorTextSecondary }" type="button">
              <AppstoreAddOutlined />
              <span
                v-if="libDraft.length + (project.externalLibraries?.length ?? 0)"
                class="libs-badge tabular"
                >{{ libDraft.length + (project.externalLibraries?.length ?? 0) }}</span
              >
            </button>
          </a-tooltip>
        </a-popover>
      </div>
    </div>

    <a-alert
      v-if="store.loadError"
      type="error"
      show-icon
      :message="uiMessage(store.loadError)"
      style="margin-top: 12px"
    />
    <a-alert
      v-if="activeTab === 'preview' && store.dirty"
      type="info"
      :message="t('code.savedPreview')"
    />
    <div class="workspace-body">
      <!-- 和对话侧、首页同一副空态骨架(淡图标 + 真 h3 + 13px 说明)。
           a-empty 自带的那张灰色插画在三种空态里各画一次,谁都不像这个应用 -->
      <div v-if="empty" class="workspace-empty">
        <div class="workspace-empty-inner">
          <FileTextOutlined
            class="workspace-empty-icon"
            :style="{ color: token.colorTextQuaternary }"
          />
          <h3 class="workspace-empty-title">{{ t('common.noDesignsYet') }}</h3>
          <div class="workspace-empty-sub" :style="{ color: token.colorTextTertiary }">
            {{ t('messages.describeYourPageOnTheLeft') }}
          </div>
        </div>
      </div>

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
            <div class="code-view">
              <CodeViewer :navigation="sourceNavigation" @navigated="sourceNavigation = null" />
            </div>
          </a-splitter-panel>
        </a-splitter>
      </template>

      <template v-else>
        <PreviewPane
          :actions-target="previewActionsTarget"
          :stack="project.stack"
          @open-source="openSource"
        />
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
  border-radius: var(--radius);
}

/*
 * 负外边距把工具栏撑回卡片的左右边缘,再自己补回 12px 内边距。
 * 不这么做的话下面那条发丝线是"缩进的",两头各悬空 12px——分隔线一旦
 * 短于它分隔的内容,就不像结构而像一处装饰。
 */
.workspace-header {
  flex-shrink: 0;
  gap: 12px;
  display: grid;
  /* Equal side columns keep the actions centered over the preview regardless of toolbar content. */
  grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr);
  align-items: center;
  margin: 0 -12px;
  /* 原来的高度由 tabs 的内边距撑出来;换成紧凑的 segmented 后自己补 */
  padding: 8px 12px;
}

.workspace-header > :first-child {
  justify-self: start;
}

.workspace-preview-actions {
  justify-self: center;
}

.workspace-header.code-mode {
  display: flex;
  flex-wrap: wrap;
}

.code-mode .workspace-header-end {
  margin-left: auto;
}

.code-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
}

.workspace-header-end {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  flex-wrap: wrap;
  gap: 12px;
  min-width: 0;
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

/* 和输入框工具条上的计数徽标同一条规矩:数量走中性填充,主色只留给
   "开着的模式"。之前这颗蓝点是整个右侧面板里最亮的像素,而它说的是
   "装了 2 个依赖包" */
.libs-badge {
  position: absolute;
  top: -2px;
  right: -4px;
  min-width: 14px;
  height: 14px;
  border-radius: var(--radius-pill);
  /* 实心的中性灰配面板色的字:没有主色也一眼是个"计数芯片",
     用半透明填充的话圆形边界看不出来,数字像是浮在图标旁边 */
  background: var(--text-soft);
  color: var(--bg-panel);
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
  padding-top: 12px;
}

.workspace-empty {
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
}

.workspace-empty-inner {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  text-align: center;
  max-width: 320px;
}

.workspace-empty-icon {
  font-size: 28px;
}

/* 排印来自 base.css 的 h3;比对话侧的 h2 低一级——那边是这一屏的主入口 */
.workspace-empty-title {
  margin: 0;
}

.workspace-empty-sub {
  font-size: 13px;
  line-height: 1.7;
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
