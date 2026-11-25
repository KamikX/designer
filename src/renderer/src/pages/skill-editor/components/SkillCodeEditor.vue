<script setup lang="ts">
import { t } from '@renderer/i18n'
import { theme } from 'antdv-next'
import { useAppConfig } from '@renderer/components/config/config'
import { monaco } from '@renderer/monaco/setup'
import { applyTheme, ensureHighlighter, LANGS } from '@renderer/monaco/highlighter'

/**
 * 技能文件的 Monaco 编辑器。
 *
 * 编辑器实例只建一次,切文件换 model。model **不走** monaco/vfs 的池:
 * 那个池是设计稿专用单例,URI 按 artifact 路径分配,技能文件混进去会撞。
 * 这里自己 createModel(skill:/// 前缀隔开命名空间),切文件和卸载时自己
 * dispose——技能文件不需要跨组件共享 model,池化反而是负担。
 *
 * 内容单向出:用户敲的每个字都通过 v-model:content 回传父组件,保存与
 * 脏标记由父组件统一管;父组件只在**换文件时**灌入新内容(伴随 path 变化),
 * 平时不会往回写,所以不存在回声循环。
 */

const props = defineProps<{
  skillName: string
  /** 正在编辑的文件相对路径,'' 表示没打开文件 */
  path: string
}>()

const content = defineModel<string>('content', { default: '' })

const emit = defineEmits<{ dirty: [] }>()

const { token } = theme.useToken()
const { dark } = useAppConfig()

const host = ref<HTMLElement | null>(null)
const loading = ref(true)
let editor: monaco.editor.IStandaloneCodeEditor | null = null
let model: monaco.editor.ITextModel | null = null

/** 按扩展名挑语言:LANGS 里注册过的才有高亮,其余 plaintext 兜底 */
function langOf(path: string): string {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase()
  const alias: Record<string, string> = { md: 'markdown', js: 'typescript', ts: 'typescript' }
  const lang = alias[ext] ?? ext
  return (LANGS as readonly string[]).includes(lang) ? lang : 'plaintext'
}

onMounted(async () => {
  await ensureHighlighter()
  loading.value = false
  await nextTick()
  if (!host.value) return

  // 选项抄自 project 的 CodeViewer(注释也在那边),差别只在可写
  editor = monaco.editor.create(host.value, {
    value: '',
    readOnly: false,
    domReadOnly: false,
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
    showFoldingControls: 'mouseover',
    overviewRulerLanes: 0,
    overviewRulerBorder: false,
    hideCursorInOverviewRuler: true,
    scrollbar: { verticalScrollbarSize: 8, horizontalScrollbarSize: 8 },
    wordWrap: 'on',
    wrappingIndent: 'indent',
    padding: { top: 8, bottom: 8 }
  })
  applyTheme(dark.value)
  syncModel()
})

onBeforeUnmount(() => {
  editor?.dispose()
  editor = null
  model?.dispose()
  model = null
})

watch(dark, (value) => applyTheme(value))

/** 换文件:换 model。父组件保证此时 content 已经是新文件的内容 */
watch(() => props.path, syncModel)

function syncModel(): void {
  if (!editor) return
  editor.setModel(null)
  model?.dispose()
  model = null
  if (!props.path) return

  model = monaco.editor.createModel(
    content.value,
    langOf(props.path),
    monaco.Uri.parse(`skill:///${props.skillName}/${props.path}`)
  )
  // 建完才挂监听:createModel 本身不算用户编辑
  model.onDidChangeContent(() => {
    if (!model) return
    content.value = model.getValue()
    emit('dirty')
  })
  editor.setModel(model)
}
</script>

<template>
  <div
    class="skill-code"
    :style="{ background: token.colorFillQuaternary, borderColor: token.colorBorderSecondary }"
  >
    <a-skeleton v-if="loading" active :paragraph="{ rows: 8 }" style="padding: 12px" />
    <a-empty
      v-else-if="!path"
      :description="t('messages.selectAFileOnTheLeftToStartEditing')"
      style="margin-top: 60px"
    />
    <div v-show="!loading && path" ref="host" class="skill-code-host" />
  </div>
</template>

<style scoped>
.skill-code {
  height: 100%;
  overflow: hidden;
  border: 1px solid transparent;
  border-radius: 6px;
}

.skill-code-host {
  height: 100%;
}
</style>
