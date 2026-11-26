import { t } from '@renderer/i18n'
import { defineStore } from 'pinia'
import { useChatStore } from './chat'
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
    loading: false,
    loadError: '',
    requestId: 0,
    files: [] as ArtifactFile[],
    /** 流式期间的半成品文件,按出现顺序 */
    pending: [] as PendingFile[],
    /** 流式期间被删掉的路径,树里要立刻消失 */
    pendingDeletes: [] as string[],
    /**
     * 预览重载信号。依赖包这类"不改文件但改装配"的设置变了之后 +1,
     * PreviewPane 监听它强刷 iframe——引导 HTML 是按项目当前状态生成的,
     * 不刷新看不到变化。
     */
    previewEpoch: 0,
    /** 当前在代码视图中选中的文件路径 */
    selectedPath: '' as string,
    drafts: {} as Record<string, string>,
    draftBaseId: '',
    saving: false,
    deleting: false,
    deleteRequestId: 0,
    exporting: false
  }),

  getters: {
    dirty(state): boolean {
      return Object.keys(state.drafts).length > 0
    },
    editingBlocked(state): boolean {
      const chat = useChatStore()
      return (
        state.loading ||
        state.saving ||
        state.deleting ||
        !state.currentId ||
        state.pending.length > 0 ||
        state.pendingDeletes.length > 0 ||
        (chat.projectId === state.projectId && chat.sending) ||
        Object.values(chat.streams).some((stream) => stream.projectId === state.projectId)
      )
    },
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
      if (Object.hasOwn(state.drafts, state.selectedPath)) return state.drafts[state.selectedPath]
      const pendingHit = state.pending.find((f) => f.path === state.selectedPath)
      if (pendingHit) return pendingHit.content
      return state.files.find((f) => f.path === state.selectedPath)?.content ?? ''
    }
  },

  actions: {
    editFile(path: string, content: string): void {
      if (this.editingBlocked) return
      const original = this.files.find((file) => file.path === path)
      if (!original) return
      if (original.content === content) delete this.drafts[path]
      else {
        this.draftBaseId = this.currentId
        this.drafts = { ...this.drafts, [path]: content }
      }
    },

    discardEdits(): void {
      this.drafts = {}
      this.draftBaseId = ''
    },

    async saveEdits(): Promise<void> {
      if (!this.dirty) return
      if (this.editingBlocked) throw new Error(t('code.saveUnavailable'))
      const projectId = this.projectId
      const baseArtifactId = this.draftBaseId
      const requestId = this.requestId
      const edits = Object.entries(this.drafts).map(([path, content]) => ({ path, content }))
      this.saving = true
      try {
        const saved = await window.api.artifact.saveEdits({
          projectId,
          baseArtifactId,
          files: edits
        })
        if (this.projectId !== projectId || this.requestId !== requestId) return
        // Commit the persisted snapshot locally so a follow-up read failure cannot duplicate a save.
        const contents = new Map(edits.map((file) => [file.path, file.content]))
        this.files = this.files.map((file) => ({
          ...file,
          content: contents.get(file.path) ?? file.content
        }))
        this.artifacts = [
          saved,
          ...this.artifacts.filter((artifact) => artifact.id !== saved.id)
        ].sort((a, b) => b.version - a.version)
        this.currentId = saved.id
        this.discardEdits()
        window.api.project
          .saveSettings(projectId, { selectedArtifactId: saved.id })
          .catch((error) => console.error('[artifact] Cannot save version selection:', error))
      } finally {
        if (this.projectId === projectId && this.requestId === requestId) this.saving = false
      }
    },

    /**
     * 换项目。
     *
     * **同步先把视图真值全清掉**,再去拉新的。只清 pending 是不够的:
     * files / currentId / selectedPath 得等两次 IPC 往返才被换掉,那几十毫秒里
     * 文件树和代码视图显示的是**上一个项目的整棵树**,预览 iframe 也会先去加载
     * 上一个项目的 preview://artifact/…。用户看到的"串",有一部分就是这个。
     */
    async loadForProject(projectId: string): Promise<void> {
      const requestId = ++this.requestId
      this.loading = true
      this.loadError = ''
      this.projectId = projectId
      this.discardEdits()
      this.saving = false
      this.deleting = false
      this.deleteRequestId++
      this.pending = []
      this.pendingDeletes = []
      this.artifacts = []
      this.currentId = ''
      this.files = []
      this.selectedPath = ''

      try {
        const [artifacts, project] = await Promise.all([
          window.api.artifact.list(projectId),
          window.api.project.get(projectId)
        ])
        if (this.requestId !== requestId || this.projectId !== projectId) return
        this.artifacts = artifacts
        const saved = project?.settings?.selectedArtifactId
        await this.select(artifacts.some((a) => a.id === saved) ? saved! : (artifacts[0]?.id ?? ''))
      } catch (error) {
        if (this.requestId !== requestId || this.projectId !== projectId) return
        this.loadError = error instanceof Error ? error.message : String(error)
        this.loading = false
      }
    },

    async select(artifactId: string): Promise<void> {
      if (artifactId && !this.artifacts.some((a) => a.id === artifactId)) return
      const requestId = ++this.requestId
      const projectId = this.projectId
      this.loadError = ''
      if (!artifactId) {
        this.currentId = ''
        this.files = []
        this.selectedPath = ''
        this.loading = false
        return
      }
      this.loading = true
      try {
        const files = await window.api.artifact.files(artifactId)
        if (this.requestId !== requestId || this.projectId !== projectId) return
        // Commit the identity and files together so preview, code and export agree.
        this.files = files
        this.currentId = artifactId
        window.api.project
          .saveSettings(projectId, { selectedArtifactId: artifactId })
          .catch((error) => console.error('[artifact] Cannot save version selection:', error))
        if (!files.some((f) => f.path === this.selectedPath)) {
          this.selectedPath = files[0]?.path ?? ''
        }
      } catch (error) {
        if (this.requestId !== requestId || this.projectId !== projectId) return
        this.loadError = error instanceof Error ? error.message : String(error)
      } finally {
        if (this.requestId === requestId && this.projectId === projectId) this.loading = false
      }
    },

    /**
     * chat store 转发来的流式事件。
     *
     * @param ownerProjectId 这条流属于哪个项目(纯聊天没有,为 undefined)
     *
     * 归属判断放在**数据的主人这一侧**,而不是留给调用方:调用方漏判一次,
     * 上一个项目还在跑的流就会把文件画进当前项目的树里,而且那些 pending
     * 永远等不到 file-end——一直挂着转圈,点开是别的项目的代码。
     */
    applyStreamEvent(event: ChatStreamEvent, ownerProjectId?: string): void {
      if (!ownerProjectId || ownerProjectId !== this.projectId) return
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

    /**
     * 新版本落库后刷新版本列表并切过去。
     *
     * 那句 `select(artifactId)` 以前是照单全收的:一旦有跨项目的 done 事件漏
     * 进来,整个代码视图和预览都会变成**别的项目**,而且 currentId 还不在
     * artifacts 里,这个状态会一直留到下次进出项目。所以这里是最后一道闸——
     * 不在本项目版本列表里的 id 绝不 select。
     */
    async afterNewVersion(artifactId: string): Promise<void> {
      const projectId = this.projectId
      const requestId = ++this.requestId
      this.loading = true
      this.loadError = ''
      let artifacts: Artifact[]
      try {
        artifacts = await window.api.artifact.list(projectId)
      } catch (error) {
        if (projectId !== this.projectId || requestId !== this.requestId) return
        this.loadError = error instanceof Error ? error.message : String(error)
        this.resetPending()
        this.loading = false
        return
      }
      if (projectId !== this.projectId || requestId !== this.requestId) return
      this.artifacts = artifacts
      if (!artifacts.some((a) => a.id === artifactId)) {
        this.loading = false
        this.resetPending()
        return
      }
      await this.select(artifactId)
      if (projectId !== this.projectId || this.requestId !== requestId + 1) return
      this.resetPending()
    },

    async deleteVersion(artifactId: string): Promise<void> {
      if (
        this.editingBlocked ||
        this.artifacts.length <= 1 ||
        !this.artifacts.some((version) => version.id === artifactId) ||
        (artifactId === this.currentId && this.dirty)
      )
        throw new Error(t('versions.unavailable'))
      const projectId = this.projectId
      const requestId = this.requestId
      const deleteRequestId = ++this.deleteRequestId
      this.deleting = true
      try {
        const remaining = await window.api.artifact.delete({ projectId, artifactId })
        if (this.projectId !== projectId || this.requestId !== requestId) return
        this.artifacts = remaining
        if (this.currentId === artifactId) {
          // A deleted snapshot must stop being visible even if loading its replacement fails.
          this.currentId = ''
          this.files = []
          this.selectedPath = ''
          this.discardEdits()
          await this.select(remaining[0].id)
        }
      } finally {
        if (this.projectId === projectId && this.deleteRequestId === deleteRequestId)
          this.deleting = false
      }
    },

    async exportCurrent(): Promise<string | null> {
      if (!this.currentId || this.loading) return null
      this.exporting = true
      try {
        return await window.api.artifact.exportTo(this.currentId)
      } finally {
        this.exporting = false
      }
    }
  }
})
