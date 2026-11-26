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
import type { SourceNavigation } from './source-location'

const props = defineProps<{ navigation?: SourceNavigation | null }>()
const emit = defineEmits<{ navigated: [] }>()

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
    colorDecorators: true,
    defaultColorDecorators: 'always',
    automaticLayout: true, // Keep the editor sized to its panel when dragging the splitter.
    minimap: { enabled: false },
    scrollBeyondLastLine: false,
    fontSize: 13,
    lineHeight: 21,
    renderLineHighlight: 'none',
    contextmenu: false,
    smoothScrolling: true,
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',

    // Monaco's default five-digit line numbers, glyph margin, and decoration column
    // consume over 100 pixels. Three digits suffice for designs of a few hundred lines,
    // and this viewer does not need breakpoint icons.
    lineNumbersMinChars: 3,
    glyphMargin: false,
    lineDecorationsWidth: 4,
    folding: true,
    showFoldingControls: 'mouseover',

    // Hide the overview ruler to save space and keep the viewer's margins balanced.
    overviewRulerLanes: 0,
    overviewRulerBorder: false,
    hideCursorInOverviewRuler: true,
    scrollbar: { verticalScrollbarSize: 8, horizontalScrollbarSize: 8 },

    // Wrap long Tailwind class lists to avoid constant horizontal scrolling in this narrow panel.
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
  // The VFS pool owns the models, so only dispose the editor view here.
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

/** Reuse the editor instance when switching files to preserve its view configuration. */
watch(() => store.selectedPath, syncModel)
watch(() => props.navigation, navigateToSource)

// Reset the model pool on project changes because route ID changes do not unmount this component.
watch(
  () => store.projectId,
  (id) => {
    editor?.setModel(null)
    setScope(id)
    syncModel()
  }
)

// Reconcile streamed content with the model and follow new lines while streaming.
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
 * The store calls this synchronously before updating its content so oldText anchors
 * still match the model. Calling later would require falling back to full replacement.
 */
function handlePatch(patch: Extract<ChatStreamEvent, { type: 'file-patch' }>): void {
  syncing = true
  let hit: ReturnType<typeof applyPatch>
  try {
    hit = applyPatch(patch.path, patch.oldText, patch.newText, patch.replaceAll)
  } finally {
    syncing = false
  }
  // If no model exists yet, getModel will use the updated content when the file is selected.
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
  navigateToSource()
}

function navigateToSource(): void {
  const target = props.navigation
  if (!editor || !target) return
  if (target.projectId !== store.projectId || target.artifactId !== store.currentId) return
  if (store.selectedPath !== target.path || !isShowing(target.path)) return
  const position = editor.getModel()!.validatePosition({
    lineNumber: target.line,
    column: target.column
  })
  editor.setPosition(position)
  editor.revealPositionInCenter(position)
  editor.focus()
  emit('navigated')
}

/** Briefly highlight changed lines to help users locate edits, then clear them after two seconds. */
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
/* Avoid horizontal padding so the editor fills its frame and stays visually aligned. */
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
/* Monaco decorations live in its internal DOM, so scoped selectors cannot reach them. */
.code-patch-flash {
  background: color-mix(in srgb, var(--app-primary) 18%, transparent);
}
</style>
