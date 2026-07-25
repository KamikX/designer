import { defineStore } from 'pinia'
import type { Artifact, ArtifactFile, ChatStreamEvent } from '@shared/types'

/**
 * 设计稿版本与文件树状态。
 *
 * 流式期间维护一份"进行中文件"(pending):file-start 时节点就出现在
 * 树里(转圈态),file-delta 增量喂内容;done 后整体切到落库的新版本。
 */

interface PendingFile {
  path: string
  content: string
  done: boolean
}

export const useArtifactStore = defineStore('artifact', {
  state: () => ({
    projectId: '' as string,
    artifacts: [] as Artifact[],
    currentId: '' as string,
    files: [] as ArtifactFile[],
    /** 流式期间的半成品文件,按出现顺序 */
    pending: [] as PendingFile[],
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
    /** 代码视图展示的文件清单:流式期间看 pending,平时看当前版本 */
    displayFiles(state): { path: string; content: string; done: boolean }[] {
      if (state.pending.length > 0) return state.pending
      return state.files.map((f) => ({ ...f, done: true }))
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
        case 'done': {
          if (event.artifactId) void this.afterNewVersion(event.artifactId)
          else this.pending = []
          break
        }
        case 'error': {
          this.pending = []
          break
        }
      }
    },

    async afterNewVersion(artifactId: string): Promise<void> {
      this.artifacts = await window.api.artifact.list(this.projectId)
      await this.select(artifactId)
      this.pending = []
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
