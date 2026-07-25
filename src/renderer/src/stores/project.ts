import { defineStore } from 'pinia'
import type { CreateProjectInput, Project } from '@shared/types'

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
      // 列表里有就直接用,深链/刷新时兜底走一次 IPC
      this.current = this.projects.find((p) => p.id === id) ?? (await window.api.project.get(id))
      return this.current
    },

    async create(input: CreateProjectInput): Promise<Project> {
      const project = await window.api.project.create(input)
      this.projects.unshift(project)
      return project
    },

    async remove(id: string): Promise<void> {
      await window.api.project.remove(id)
      this.projects = this.projects.filter((p) => p.id !== id)
      if (this.current?.id === id) this.current = null
    }
  }
})
