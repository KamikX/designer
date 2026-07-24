/**
 * 主进程 / preload / 渲染进程共用的契约类型。
 *
 * 放在 shared 而不是从 main 里 import，是因为 tsconfig.web.json 会收
 * src/preload/*.d.ts；一旦那里引用了 src/main 的文件，整个主进程目录
 * 就被拖进 web 工程，composite 模式下会报 TS6307。
 *
 * 这里只放类型，不放任何运行时代码。
 */

export type Lang = 'zh-CN' | 'en-US'

export interface AppConfig {
  lang: Lang
  dark: boolean
  primaryColor: string
  window: { width: number; height: number }
}

export interface Project {
  id: number
  name: string
  createdAt: string
  updatedAt: string
}

/**
 * 暴露给渲染进程的 API 面。
 *
 * 只有领域方法，没有原始 SQL、没有文件路径——渲染进程不需要知道
 * 底下是 SQLite 还是别的。
 */
export interface DesignerApi {
  /** preload 同步取到的初始配置，供首帧使用 */
  initialConfig: AppConfig
  config: {
    read: () => Promise<AppConfig>
    patch: (patch: Partial<AppConfig>) => Promise<AppConfig>
  }
  project: {
    list: () => Promise<Project[]>
    create: (name: string) => Promise<Project>
    rename: (id: number, name: string) => Promise<Project | null>
    remove: (id: number) => Promise<void>
  }
}
