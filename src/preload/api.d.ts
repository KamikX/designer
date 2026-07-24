import { ElectronAPI } from '@electron-toolkit/preload'
import type { DesignerApi } from '../shared/types'

// 契约类型都在 src/shared，不从 src/main 取——tsconfig.web.json 会收
// src/preload/*.d.ts，引用主进程文件会把整个 main 目录拖进 web 工程
export type { AppConfig, DesignerApi, Lang, Project } from '../shared/types'

declare global {
  interface Window {
    electron: ElectronAPI
    api: DesignerApi
  }
}
