import { defineStore } from 'pinia'
import type { CreateProjectInput, PreviewLib, Project } from '@shared/types'

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
    async setLibs(id: string, libs: PreviewLib[]): Promise<void> {
      const updated = await window.api.project.setLibs(id, libs)
      if (!updated) return
      const at = this.projects.findIndex((p) => p.id === id)
      if (at >= 0) this.projects[at] = updated
      if (this.current?.id === id) this.current = updated
    },

    /** 修改项目级视觉方向，并同步列表与当前工作台中的项目快照。 */
    async setStyleBrief(id: string, styleBrief: string): Promise<void> {
      const updated = await window.api.project.setStyleBrief(id, styleBrief)
      if (!updated) return
      const at = this.projects.findIndex((p) => p.id === id)
      if (at >= 0) this.projects[at] = updated
      if (this.current?.id === id) this.current = updated
    },

    async remove(id: string): Promise<void> {
      await window.api.project.remove(id)
      this.projects = this.projects.filter((p) => p.id !== id)
      if (this.current?.id === id) this.current = null
    }
  }
})
