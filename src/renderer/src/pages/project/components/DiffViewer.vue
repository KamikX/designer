<script setup lang="ts">
import { t } from '@renderer/i18n'
import { useArtifactStore } from '@renderer/stores/artifact'
import { useAppConfig } from '@renderer/components/config/config'
import { monaco } from '@renderer/monaco/setup'
import { applyTheme, ensureHighlighter } from '@renderer/monaco/highlighter'
import { langOf } from '@renderer/monaco/vfs'

const props = defineProps<{
  renderSideBySide: boolean
}>()

/**
 * Read-only diff viewer backed by Monaco's diff editor.
 *
 * Models are created and disposed locally rather than drawn from the VFS pool
 * so diff inspection never interferes with live code editing or undo history.
 */

const { dark } = useAppConfig()
const store = useArtifactStore()

const host = ref<HTMLElement | null>(null)
const loading = ref(true)
let diffEditor: monaco.editor.IStandaloneDiffEditor | null = null
let originalModel: monaco.editor.ITextModel | null = null
let modifiedModel: monaco.editor.ITextModel | null = null
let modelSeq = 0

const selectedPath = computed(() => store.selectedPath)
const status = computed(() =>
  selectedPath.value ? store.diffStatusByPath[selectedPath.value] : undefined
)
const originalContent = computed(
  () => store.diffBaseFiles.find((f) => f.path === selectedPath.value)?.content ?? ''
)
const modifiedContent = computed(
  () => store.files.find((f) => f.path === selectedPath.value)?.content ?? ''
)

const emptyState = computed(() => {
  if (store.diffLoading) return ''
  if (store.changedPaths.length === 0 && !selectedPath.value) return t('diff.noChangesInVersion')
  if (!selectedPath.value) return t('diff.selectFile')
  if (!status.value) return t('diff.noChangesInFile')
  return ''
})

function disposeModels(): void {
  if (diffEditor) diffEditor.setModel(null)
  originalModel?.dispose()
  modifiedModel?.dispose()
  originalModel = null
  modifiedModel = null
}

function syncModels(): void {
  if (!diffEditor) return
  disposeModels()
  if (!selectedPath.value || !status.value || store.diffLoading) return
  const language = langOf(selectedPath.value)
  const seq = ++modelSeq
  originalModel = monaco.editor.createModel(
    originalContent.value,
    language,
    monaco.Uri.parse(`diff-original:///${seq}/${selectedPath.value}`)
  )
  modifiedModel = monaco.editor.createModel(
    modifiedContent.value,
    language,
    monaco.Uri.parse(`diff-modified:///${seq}/${selectedPath.value}`)
  )
  diffEditor.setModel({ original: originalModel, modified: modifiedModel })
}

function goToDiff(direction: 'next' | 'previous'): void {
  diffEditor?.goToDiff(direction)
}

defineExpose({ goToDiff })

onMounted(async () => {
  await ensureHighlighter()
  loading.value = false
  await nextTick()
  if (!host.value) return

  diffEditor = monaco.editor.createDiffEditor(host.value, {
    readOnly: true,
    originalEditable: false,
    renderSideBySide: props.renderSideBySide,
    // Keep side-by-side usable inside the split workspace pane without collapsing early to inline.
    useInlineViewWhenSpaceIsLimited: false,
    automaticLayout: true,
    minimap: { enabled: false },
    scrollBeyondLastLine: false,
    fontSize: 13,
    lineHeight: 21,
    renderLineHighlight: 'none',
    contextmenu: false,
    smoothScrolling: true,
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    lineNumbersMinChars: 3,
    glyphMargin: false,
    lineDecorationsWidth: 4,
    folding: true,
    overviewRulerLanes: 2,
    overviewRulerBorder: false,
    scrollbar: { verticalScrollbarSize: 8, horizontalScrollbarSize: 8 },
    wordWrap: 'on',
    padding: { top: 8, bottom: 8 }
  })
  applyTheme(dark.value)
  syncModels()
})

onBeforeUnmount(() => {
  disposeModels()
  diffEditor?.dispose()
  diffEditor = null
})

watch(dark, (value) => applyTheme(value))

watch(
  () => props.renderSideBySide,
  (sideBySide) => {
    diffEditor?.updateOptions({ renderSideBySide: sideBySide })
  }
)

watch(
  () => [
    selectedPath.value,
    status.value,
    originalContent.value,
    modifiedContent.value,
    store.diffLoading
  ],
  () => syncModels()
)
</script>

<template>
  <div class="diff-viewer">
    <div v-if="loading || store.diffLoading" class="diff-viewer-state">
      <a-spin size="small" />
    </div>
    <div v-else-if="emptyState" class="diff-viewer-state diff-viewer-empty">
      {{ emptyState }}
    </div>
    <div
      ref="host"
      class="diff-viewer-host"
      :class="{ 'diff-viewer-host--hidden': loading || store.diffLoading || Boolean(emptyState) }"
    />
  </div>
</template>

<style scoped>
.diff-viewer {
  position: relative;
  height: 100%;
  width: 100%;
  min-height: 0;
  min-width: 0;
}

.diff-viewer-host {
  height: 100%;
  width: 100%;
}

.diff-viewer-host--hidden {
  visibility: hidden;
  pointer-events: none;
}

.diff-viewer-state {
  position: absolute;
  inset: 0;
  z-index: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-muted);
  font-size: 13px;
}

.diff-viewer-empty {
  padding: 16px;
  text-align: center;
}
</style>
