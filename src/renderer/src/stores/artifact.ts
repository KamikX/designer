import { defineStore } from 'pinia'
import type { Artifact, ArtifactFile, ChatStreamEvent } from '@shared/types'

/**
 * 设计稿版本与文件树状态。
 *
 * 流式期间维护一份"进行中文件"(pending),两种协议各喂一半:
 * - markers:file-start 时节点就出现在树里(转圈态),file-delta 增量喂内容。
 * - tools:file-patch 直接把改动打进内容,文件一次到位没有中间态。
 *
 * done 后整体切到落库的新版本。
 */

interface PendingFile {
  path: string
  content: string
  done: boolean
}

type FilePatch = Extract<ChatStreamEvent, { type: 'file-patch' }>

/**
 * patch 监听器(CodeViewer 挂载时注册)。
 *
 * 必须在 store 内容更新**之前**同步调用:Monaco 那边靠 oldText 当锚点
 * 定位,一旦 model 已经被刷成新内容,锚点就找不着了,只能退回全量替换
 * ——滚动位置、折叠状态全丢,增量编辑的意义也就没了。
 */
type PatchListener = (patch: FilePatch) => void

let patchListener: PatchListener | null = null

export function setPatchListener(listener: PatchListener | null): void {
  patchListener = listener
}

/** 按锚点替换。不用 String.replace:替换串里的 $& / $1 会被当成模式展开 */
function applyTextPatch(source: string, patch: FilePatch): string {
  if (!patch.oldText) return patch.newText
  if (patch.replaceAll) return source.split(patch.oldText).join(patch.newText)
  const at = source.indexOf(patch.oldText)
  if (at < 0) return source
  return source.slice(0, at) + patch.newText + source.slice(at + patch.oldText.length)
}

export const useArtifactStore = defineStore('artifact', {
  state: () => ({
    projectId: '' as string,
    artifacts: [] as Artifact[],
    currentId: '' as string,
    files: [] as ArtifactFile[],
    /** 流式期间的半成品文件,按出现顺序 */
    pending: [] as PendingFile[],
    /** 流式期间被删掉的路径,树里要立刻消失 */
    pendingDeletes: [] as string[],
    /** 当前在代码视图中选中的文件路径 */
    selectedPath: '' as string,
    exporting: false
  }),

  getters: {
    current(state): Artifact | null {
      return state.artifacts.find((a) => a.id === state.currentId) ?? null
    },
    streamingFiles(state): boolean {
      return state.pending.length > 0
    },
    /**
     * 代码视图展示的文件清单。
     *
     * 流式期间用当前版本打底、pending 覆盖上去:工具协议下一轮可能只动
     * 一个文件,只显示 pending 会让整棵树塌成一个节点。
     */
    displayFiles(state): { path: string; content: string; done: boolean }[] {
      if (state.pending.length === 0 && state.pendingDeletes.length === 0) {
        return state.files.map((f) => ({ ...f, done: true }))
      }
      const merged = new Map<string, { path: string; content: string; done: boolean }>()
      for (const f of state.files) merged.set(f.path, { ...f, done: true })
      for (const path of state.pendingDeletes) merged.delete(path)
      for (const f of state.pending) merged.set(f.path, f)
      return [...merged.values()].sort((a, b) => a.path.localeCompare(b.path))
    },
    selectedContent(state): string {
      const pendingHit = state.pending.find((f) => f.path === state.selectedPath)
      if (pendingHit) return pendingHit.content
      return state.files.find((f) => f.path === state.selectedPath)?.content ?? ''
    }
  },

  actions: {
    async loadForProject(projectId: string): Promise<void> {
      this.projectId = projectId
      this.pending = []
      this.pendingDeletes = []
      this.artifacts = await window.api.artifact.list(projectId)
      await this.select(this.artifacts[0]?.id ?? '')
    },

    async select(artifactId: string): Promise<void> {
      this.currentId = artifactId
      this.files = artifactId ? await window.api.artifact.files(artifactId) : []
      if (!this.files.some((f) => f.path === this.selectedPath)) {
        this.selectedPath = this.files[0]?.path ?? ''
      }
    },

    /** chat store 转发来的流式事件 */
    applyStreamEvent(event: ChatStreamEvent): void {
      switch (event.type) {
        case 'file-start': {
          const existing = this.pending.find((f) => f.path === event.path)
          if (existing) {
            existing.content = ''
            existing.done = false
          } else {
            this.pending.push({ path: event.path, content: '', done: false })
          }
          this.pendingDeletes = this.pendingDeletes.filter((p) => p !== event.path)
          // 自动跟随正在生成的文件,流式打码的观感就是从这来的
          this.selectedPath = event.path
          break
        }
        case 'file-delta': {
          const file = this.pending.find((f) => f.path === event.path)
          if (file) file.content += event.text
          break
        }
        case 'file-end': {
          const file = this.pending.find((f) => f.path === event.path)
          if (file) file.done = true
          break
        }
        case 'file-patch': {
          // 先让 Monaco 拿着旧内容做增量编辑,再更新 store 自己的副本
          patchListener?.(event)

          const existing = this.pending.find((f) => f.path === event.path)
          const base =
            existing?.content ?? this.files.find((f) => f.path === event.path)?.content ?? ''
          const next = applyTextPatch(base, event)
          if (existing) {
            existing.content = next
            existing.done = true
          } else {
            this.pending.push({ path: event.path, content: next, done: true })
          }
          this.pendingDeletes = this.pendingDeletes.filter((p) => p !== event.path)
          this.selectedPath = event.path
          break
        }
        case 'file-delete': {
          this.pending = this.pending.filter((f) => f.path !== event.path)
          if (!this.pendingDeletes.includes(event.path)) this.pendingDeletes.push(event.path)
          if (this.selectedPath === event.path) this.selectedPath = ''
          break
        }
        case 'done': {
          if (event.artifactId) void this.afterNewVersion(event.artifactId)
          else this.resetPending()
          break
        }
        case 'error': {
          this.resetPending()
          break
        }
      }
    },

    resetPending(): void {
      this.pending = []
      this.pendingDeletes = []
    },

    async afterNewVersion(artifactId: string): Promise<void> {
      this.artifacts = await window.api.artifact.list(this.projectId)
      await this.select(artifactId)
      this.resetPending()
    },

    async exportCurrent(): Promise<string | null> {
      if (!this.currentId) return null
      this.exporting = true
      try {
        return await window.api.artifact.exportTo(this.currentId)
      } finally {
        this.exporting = false
      }
    }
  }
})
