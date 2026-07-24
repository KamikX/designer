import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import type { AppConfig, DesignerApi } from './api'

/**
 * 初始配置在 preload 加载时同步取一次。
 *
 * 渲染进程首帧就能拿到正确的主题 / 语言，不用先按默认值渲染一遍再等
 * 异步 IPC 回来纠正——那样会看到明显的闪色。
 */
const initialConfig = ipcRenderer.sendSync('config:read-sync') as AppConfig

const api: DesignerApi = {
  initialConfig,
  config: {
    read: () => ipcRenderer.invoke('config:read'),
    patch: (patch) => ipcRenderer.invoke('config:patch', patch)
  },
  project: {
    list: () => ipcRenderer.invoke('project:list'),
    create: (name) => ipcRenderer.invoke('project:create', name),
    rename: (id, name) => ipcRenderer.invoke('project:rename', id, name),
    remove: (id) => ipcRenderer.invoke('project:delete', id)
  }
}

// Use `contextBridge` APIs to expose Electron APIs to
// renderer only if context isolation is enabled, otherwise
// just add to the DOM global.
if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.electron = electronAPI
  // @ts-ignore (define in dts)
  window.api = api
}
