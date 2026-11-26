<script setup lang="ts">
import { useCodeEdits } from '@renderer/composables/useCodeEdits'
import { t } from '@renderer/i18n'
import { theme } from 'antdv-next'
import { setPatchListener, useArtifactStore } from '@renderer/stores/artifact'
import { useAppConfig } from '@renderer/components/config/config'
import { monaco } from '@renderer/monaco/setup'
import { applyTheme, ensureHighlighter } from '@renderer/monaco/highlighter'
import { applyPatch, getModel, setContent, setScope } from '@renderer/monaco/vfs'
import type { ChatStreamEvent } from '@shared/types'

/**
 * Keep a single editor and switch pooled models so file changes preserve undo history.
 * Programmatic updates are suppressed to keep AI streaming separate from manual drafts.
 */

const { token } = theme.useToken()
const { dark } = useAppConfig()
const store = useArtifactStore()
const { save } = useCodeEdits()
let syncing = false

const host = ref<HTMLElement | null>(null)
const loading = ref(true)
let editor: monaco.editor.IStandaloneCodeEditor | null = null
let decorations: monaco.editor.IEditorDecorationsCollection | null = null
let flashTimer: ReturnType<typeof setTimeout> | null = null

const hasContent = computed(() => store.selectedPath !== '')

onMounted(async () => {
  setScope(store.projectId)
  setPatchListener(handlePatch)
  await ensureHighlighter()
  loading.value = false
  await nextTick()
  if (!host.value) return

  editor = monaco.editor.create(host.value, {
    value: '',
    readOnly: store.editingBlocked,
    domReadOnly: store.editingBlocked,
    automaticLayout: true, // splitter 拖拽时自己重排
    minimap: { enabled: false },
    scrollBeyondLastLine: false,
    fontSize: 13,
    lineHeight: 21,
    renderLineHighlight: 'none',
    contextmenu: false,
    smoothScrolling: true,
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',

    // 左边槽位:Monaco 默认给行号留 5 位数字的宽度,再加字形边距和
    // 装饰列,一共吃掉一百多像素——设计稿最多几百行,3 位足够;
    // 只读查看器也不会有断点图标
    lineNumbersMinChars: 3,
    glyphMargin: false,
    lineDecorationsWidth: 4,
    folding: true,
    showFoldingControls: 'mouseover',

    // 右边槽位:概览标尺在只读场景没什么用,占的宽度还让左右看着不对称
    overviewRulerLanes: 0,
    overviewRulerBorder: false,
    hideCursorInOverviewRuler: true,
    scrollbar: { verticalScrollbarSize: 8, horizontalScrollbarSize: 8 },

    // 面板本来就窄,还挂着一长串 Tailwind 类名;不折行就得一直横向拖
    wordWrap: 'on',
    wrappingIndent: 'indent',
    padding: { top: 8, bottom: 8 }
  })
  editor.onDidChangeModelContent(() => {
    if (syncing || !editor || !store.selectedPath) return
    store.editFile(store.selectedPath, editor.getValue())
  })
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
    if (!store.editingBlocked) void save().catch(() => {})
  })
  decorations = editor.createDecorationsCollection()
  applyTheme(dark.value)
  syncModel()
})

onBeforeUnmount(() => {
  setPatchListener(null)
  if (flashTimer) clearTimeout(flashTimer)
  // model 归 vfs 池统一管,这里只销毁视图
  editor?.dispose()
  editor = null
})

watch(dark, (value) => applyTheme(value))
watch(
  () => store.editingBlocked,
  (blocked) => {
    editor?.updateOptions({ readOnly: blocked, domReadOnly: blocked })
  }
)

/** 换文件:只换 model,编辑器实例不动 */
watch(() => store.selectedPath, syncModel)

// 换项目:整池清掉再重建。路由只变 id 时组件不会卸载,不清就会串味
watch(
  () => store.projectId,
  (id) => {
    editor?.setModel(null)
    setScope(id)
    syncModel()
  }
)

// 全文流式增长:内容对不上就整体校正,并贴底滚动
watch(
  () => store.selectedContent,
  (content) => {
    if (!editor || !store.selectedPath) return
    if (!isShowing(store.selectedPath)) {
      syncModel()
      return
    }
    syncing = true
    let changed: boolean
    try {
      changed = setContent(store.selectedPath, content)
    } finally {
      syncing = false
    }
    if (!changed) return
    if (store.streamingFiles) editor.revealLine(editor.getModel()?.getLineCount() ?? 1)
  }
)

/**
 * 工具局部编辑。由 store 在更新自己那份内容**之前**同步调用——晚一步
 * model 就成新内容了,oldText 锚点再也定位不到,只能退回全量替换。
 */
function handlePatch(patch: Extract<ChatStreamEvent, { type: 'file-patch' }>): void {
  syncing = true
  let hit: ReturnType<typeof applyPatch>
  try {
    hit = applyPatch(patch.path, patch.oldText, patch.newText, patch.replaceAll)
  } finally {
    syncing = false
  }
  // 命不中说明这个文件还没建 model,等它被选中时 getModel 直接拿新内容建
  if (!hit || !editor || !isShowing(patch.path)) return
  editor.revealLineInCenterIfOutsideViewport(hit.startLine)
  flash(hit.startLine, hit.endLine)
}

function isShowing(path: string): boolean {
  return editor?.getModel()?.uri.path === `/${path}`
}

function syncModel(): void {
  if (!editor) return
  syncing = true
  try {
    editor.setModel(store.selectedPath ? getModel(store.selectedPath, store.selectedContent) : null)
  } finally {
    syncing = false
  }
}

/** 改动行高亮,2s 后自动褪去 */
function flash(startLine: number, endLine: number): void {
  if (!decorations) return
  decorations.set([
    {
      range: new monaco.Range(startLine, 1, Math.max(startLine, endLine), 1),
      options: { isWholeLine: true, className: 'code-patch-flash' }
    }
  ])
  if (flashTimer) clearTimeout(flashTimer)
  flashTimer = setTimeout(() => decorations?.clear(), 2000)
}
</script>

<template>
  <div
    class="code-viewer"
    :style="{ background: token.colorFillQuaternary, borderColor: token.colorBorderSecondary }"
  >
    <a-skeleton v-if="loading" active :paragraph="{ rows: 8 }" style="padding: 12px" />
    <a-empty
      v-else-if="!hasContent"
      :description="t('messages.selectAFileOnTheLeftToViewItsContents')"
      style="margin-top: 60px"
    />
    <div v-show="!loading && hasContent" ref="host" class="code-host" />
  </div>
</template>

<style scoped>
/* 不加横向 padding:编辑器就该铺满自己的框,两边留白反而像没对齐 */
.code-viewer {
  height: 100%;
  overflow: hidden;
  border: 1px solid transparent;
  border-radius: 6px;
}

.code-host {
  height: 100%;
}
</style>

<style>
/* Monaco 的 decoration 挂在编辑器内部 DOM 上,scoped 选择器命不中 */
.code-patch-flash {
  background: color-mix(in srgb, var(--app-primary) 18%, transparent);
}
</style>
