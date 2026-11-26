import { computed, ref, watch } from 'vue'
import { defineStore } from 'pinia'
import { useArtifactStore } from './artifact'

export interface CodeRange {
  startLine: number
  startColumn: number
  endLine: number
  endColumn: number
}

export interface CodeSelection extends CodeRange {
  id: string
  projectId: string
  artifactId: string
  path: string
}

export const MAX_CODE_SELECTIONS = 20

export function normalizeCodeRange(range: CodeRange): CodeRange | null {
  const values = Object.values(range)
  if (values.some((value) => !Number.isInteger(value) || value < 1)) return null
  const { startLine, startColumn, endLine, endColumn } = range
  if (startLine === endLine && startColumn === endColumn) return null
  return startLine > endLine || (startLine === endLine && startColumn > endColumn)
    ? { startLine: endLine, startColumn: endColumn, endLine: startLine, endColumn: startColumn }
    : { startLine, startColumn, endLine, endColumn }
}

export function codeSelectionLabel(selection: CodeSelection): string {
  return `${selection.path}:${selection.startLine}:${selection.startColumn}–${selection.endLine}:${selection.endColumn}`
}

export const useCodeSelectionStore = defineStore('code-selection', () => {
  const artifact = useArtifactStore()
  const selections = ref<CodeSelection[]>([])
  // Snapshots only validate coordinates; they never become chat attachments.
  const snapshots = new Map<string, string>()
  let nextId = 0
  const contents = computed(
    () =>
      new Map(
        artifact.displayFiles.map((file) => [file.path, artifact.drafts[file.path] ?? file.content])
      )
  )

  function validate(): void {
    selections.value = selections.value.filter(
      (selection) =>
        selection.projectId === artifact.projectId &&
        selection.artifactId === artifact.currentId &&
        contents.value.has(selection.path) &&
        contents.value.get(selection.path) === snapshots.get(selection.id)
    )
    const ids = new Set(selections.value.map((selection) => selection.id))
    for (const id of snapshots.keys()) if (!ids.has(id)) snapshots.delete(id)
  }

  // Keep invalidation active even when the code editor is unmounted.
  watch(() => [artifact.projectId, artifact.currentId, contents.value], validate, { flush: 'sync' })

  function add(path: string, input: CodeRange): boolean {
    validate()
    const range = normalizeCodeRange(input)
    if (
      !range ||
      !artifact.projectId ||
      artifact.editingBlocked ||
      artifact.dirty ||
      !contents.value.has(path)
    )
      return false
    const content = contents.value.get(path)!
    const lines = content.split('\n')
    if (
      range.endLine > lines.length ||
      range.startColumn > lines[range.startLine - 1].replace(/\r$/, '').length + 1 ||
      range.endColumn > lines[range.endLine - 1].replace(/\r$/, '').length + 1
    )
      return false
    if (
      selections.value.length >= MAX_CODE_SELECTIONS ||
      selections.value.some(
        (item) =>
          item.path === path &&
          item.startLine === range.startLine &&
          item.startColumn === range.startColumn &&
          item.endLine === range.endLine &&
          item.endColumn === range.endColumn
      )
    )
      return false
    const selection = {
      ...range,
      id: String(++nextId),
      path,
      projectId: artifact.projectId,
      artifactId: artifact.currentId
    }
    snapshots.set(selection.id, content)
    selections.value.push(selection)
    return true
  }

  function remove(id: string): void {
    selections.value = selections.value.filter((selection) => selection.id !== id)
    snapshots.delete(id)
  }

  function clear(): void {
    selections.value = []
    snapshots.clear()
  }

  return { selections, add, remove, clear, validate }
})
