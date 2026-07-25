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
    get: (id) => ipcRenderer.invoke('project:get', id),
    create: (input) => ipcRenderer.invoke('project:create', input),
    rename: (id, name) => ipcRenderer.invoke('project:rename', id, name),
    remove: (id) => ipcRenderer.invoke('project:delete', id)
  },
  conversation: {
    ensureDesign: (projectId) => ipcRenderer.invoke('conversation:ensure-design', projectId)
  },
  provider: {
    list: () => ipcRenderer.invoke('provider:list'),
    setKey: (id, apiKey) => ipcRenderer.invoke('provider:set-key', id, apiKey),
    clearKey: (id) => ipcRenderer.invoke('provider:clear-key', id),
    update: (id, patch) => ipcRenderer.invoke('provider:update', id, patch),
    create: (input) => ipcRenderer.invoke('provider:create', input),
    remove: (id) => ipcRenderer.invoke('provider:delete', id),
    test: (id, modelId) => ipcRenderer.invoke('provider:test', id, modelId),
    fetchModels: (input) => ipcRenderer.invoke('provider:fetch-models', input)
  },
  model: {
    list: (providerId) => ipcRenderer.invoke('model:list', providerId),
    setSelection: (providerId, selections) =>
      ipcRenderer.invoke('model:set-selection', providerId, selections)
  },
  chat: {
    listMessages: (conversationId) => ipcRenderer.invoke('chat:list-messages', conversationId),
    send: (input) => ipcRenderer.invoke('chat:send', input),
    abort: (streamId) => ipcRenderer.invoke('chat:abort', streamId),
    onStream: (cb) => {
      // 只透传 payload,不把 IpcRendererEvent 漏给渲染层
      const listener = (_e: Electron.IpcRendererEvent, event: Parameters<typeof cb>[0]): void =>
        cb(event)
      ipcRenderer.on('chat:stream', listener)
      return () => ipcRenderer.removeListener('chat:stream', listener)
    }
  },
  artifact: {
    list: (projectId) => ipcRenderer.invoke('artifact:list', projectId),
    files: (artifactId) => ipcRenderer.invoke('artifact:files', artifactId),
    exportTo: (artifactId) => ipcRenderer.invoke('artifact:export', artifactId)
  },
  storage: {
    getConfig: () => ipcRenderer.invoke('storage:get-config'),
    setConfig: (input) => ipcRenderer.invoke('storage:set-config', input),
    test: (input) => ipcRenderer.invoke('storage:test', input),
    importAsset: (filePath) => ipcRenderer.invoke('storage:import-asset', filePath)
  },
  sync: {
    getConfig: () => ipcRenderer.invoke('sync:get-config'),
    setConfig: (input) => ipcRenderer.invoke('sync:set-config', input)
  },
  mcp: {
    list: () => ipcRenderer.invoke('mcp:list'),
    create: (input) => ipcRenderer.invoke('mcp:create', input),
    update: (id, patch) => ipcRenderer.invoke('mcp:update', id, patch),
    remove: (id) => ipcRenderer.invoke('mcp:delete', id),
    importJson: (json) => ipcRenderer.invoke('mcp:import-json', json)
  },
  skill: {
    list: () => ipcRenderer.invoke('skill:list'),
    create: (input) => ipcRenderer.invoke('skill:create', input),
    update: (id, patch) => ipcRenderer.invoke('skill:update', id, patch),
    remove: (id) => ipcRenderer.invoke('skill:delete', id),
    // 可选 zipPath 供自动化测试直传,UI 侧不传则由主进程弹文件框
    importPackage: (zipPath?: string) => ipcRenderer.invoke('skill:import-package', zipPath)
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
