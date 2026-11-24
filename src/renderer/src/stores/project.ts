import { acceptHMRUpdate, defineStore } from 'pinia'
import type {
  CreateProjectInput,
  ExternalLibraryRef,
  PreviewLib,
  Project,
  VisualGuidance
} from '@shared/types'

export const useProjectStore = defineStore('project', {
  state: () => ({
    projects: [] as Project[],
    loaded: false,
    /** 工作台当前打开的项目 */
    current: null as Project | null
  }),

  actions: {
    async load(force = false): Promise<void> {
      if (this.loaded && !force) return
      this.projects = await window.api.project.list()
      this.loaded = true
    },

    async open(id: string): Promise<Project | null> {
      // 每次都从库里现读:settings(模型/技能勾选)在工作台里随手就会改,
      // 首页加载的列表快照极易过期——用它恢复会把刚改的选择又盖回去。
      // 列表只作为 IPC 拿不到时的兜底(比如刚创建还没入库完成的竞态)
      this.current =
        (await window.api.project.get(id)) ?? this.projects.find((p) => p.id === id) ?? null
      return this.current
    },

    async create(input: CreateProjectInput): Promise<Project> {
      const project = await window.api.project.create(input)
      this.projects.unshift(project)
      return project
    },

    /** 修改依赖包(创建后可改;影响预览装配与提示词,不牵动文件树) */
    async setExternalLibraries(id: string, refs: ExternalLibraryRef[]): Promise<void> {
      const updated = await window.api.project.setExternalLibraries(
        id,
        refs.map((ref) => ({ name: ref.name, version: ref.version }))
      )
      if (!updated) throw new Error('Project not found')
      const at = this.projects.findIndex((p) => p.id === id)
      if (at >= 0) this.projects[at] = updated
      if (this.current?.id === id) this.current = updated
    },
    async setLibs(id: string, libs: PreviewLib[]): Promise<void> {
      const updated = await window.api.project.setLibs(id, libs)
      if (!updated) return
      const at = this.projects.findIndex((p) => p.id === id)
      if (at >= 0) this.projects[at] = updated
      if (this.current?.id === id) this.current = updated
    },

    /** Keep both project snapshots aligned with the persisted visual guidance. */
    async setVisualGuidance(id: string, guidance: VisualGuidance): Promise<void> {
      const updated = await window.api.project.setVisualGuidance(id, { ...guidance })
      if (!updated) throw new Error('Project not found')
      const at = this.projects.findIndex((p) => p.id === id)
      if (at >= 0) this.projects[at] = updated
      if (this.current?.id === id) this.current = updated
    },

    async setStyleBrief(id: string, styleBrief: string): Promise<void> {
      const updated = await window.api.project.setStyleBrief(id, styleBrief)
      if (!updated) return
      const at = this.projects.findIndex((p) => p.id === id)
      if (at >= 0) this.projects[at] = updated
      if (this.current?.id === id) this.current = updated
    },

    /**
     * 本项目的单轮工具调用上限。`null` = 跟随全局,`0` = 不限。
     *
     * saveSettings 是合并写且不回吐整行,所以这里手动把本地快照也补上——
     * 不补的话弹层一关再开,输入框又变回旧值。
     */
    async setToolCallLimit(id: string, limit: number | null): Promise<void> {
      await window.api.project.saveSettings(id, { toolCallLimit: limit })
      const patch = (project: Project): Project => ({
        ...project,
        settings: { ...project.settings, toolCallLimit: limit }
      })
      const at = this.projects.findIndex((p) => p.id === id)
      if (at >= 0) this.projects[at] = patch(this.projects[at])
      if (this.current?.id === id) this.current = patch(this.current)
    },

    async remove(id: string): Promise<void> {
      await window.api.project.remove(id)
      this.projects = this.projects.filter((p) => p.id !== id)
      if (this.current?.id === id) this.current = null
    }
  }
})

// Preserve project state while adding updated actions to stores already used by mounted components.
if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useProjectStore, import.meta.hot))
}
