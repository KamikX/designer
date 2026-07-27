import { contextBridge, ipcRenderer, webUtils } from 'electron'
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
    setLibs: (id, libs) => ipcRenderer.invoke('project:set-libs', id, libs),
    setStyleBrief: (id, styleBrief) =>
      ipcRenderer.invoke('project:set-style-brief', id, styleBrief),
    remove: (id) => ipcRenderer.invoke('project:delete', id),
    saveSettings: (id, patch) => ipcRenderer.invoke('project:save-settings', id, patch)
  },
  conversation: {
    ensureDesign: (projectId) => ipcRenderer.invoke('conversation:ensure-design', projectId)
  },
  market: {
    skills: () => ipcRenderer.invoke('market:skills'),
    status: () => ipcRenderer.invoke('market:status'),
    installedSkills: () => ipcRenderer.invoke('market:installed-skills'),
    mcp: () => ipcRenderer.invoke('market:mcp')
  },
  observability: {
    runForMessage: (messageId) => ipcRenderer.invoke('observability:run-for-message', messageId),
    usage: (query) => ipcRenderer.invoke('observability:usage', query),
    clearUsage: () => ipcRenderer.invoke('observability:clear-usage')
  },
  chatSession: {
    list: () => ipcRenderer.invoke('chat:list'),
    create: () => ipcRenderer.invoke('chat:create'),
    rename: (id, title) => ipcRenderer.invoke('chat:rename', id, title),
    remove: (id) => ipcRenderer.invoke('chat:delete', id),
    saveSettings: (id, patch) => ipcRenderer.invoke('chat:save-settings', id, patch)
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
  group: {
    roles: () => ipcRenderer.invoke('group:roles'),
    list: () => ipcRenderer.invoke('group:list'),
    create: (input) => ipcRenderer.invoke('group:create', input),
    update: (input) => ipcRenderer.invoke('group:update', input),
    rename: (id, name) => ipcRenderer.invoke('group:rename', id, name),
    remove: (id) => ipcRenderer.invoke('group:delete', id),
    messages: (id) => ipcRenderer.invoke('group:messages', id),
    send: (input) => ipcRenderer.invoke('group:send', input),
    abort: (id) => ipcRenderer.invoke('group:abort', id),
    onStream: (cb) => {
      const listener = (_e: Electron.IpcRendererEvent, event: Parameters<typeof cb>[0]): void =>
        cb(event)
      ipcRenderer.on('group:stream', listener)
      return () => ipcRenderer.removeListener('group:stream', listener)
    }
  },
  chat: {
    listMessages: (conversationId) => ipcRenderer.invoke('chat:list-messages', conversationId),
    send: (input) => ipcRenderer.invoke('chat:send', input),
    abort: (streamId) => ipcRenderer.invoke('chat:abort', streamId),
    answerQuestion: (questionId, answer) =>
      ipcRenderer.invoke('chat:answer-question', questionId, answer),
    onStream: (cb) => {
      // 只透传 payload,不把 IpcRendererEvent 漏给渲染层
      const listener = (_e: Electron.IpcRendererEvent, event: Parameters<typeof cb>[0]): void =>
        cb(event)
      ipcRenderer.on('chat:stream', listener)
      return () => ipcRenderer.removeListener('chat:stream', listener)
    }
  },
  preview: {
    reportError: (projectId, artifactId, message) =>
      ipcRenderer.invoke('preview:report-error', projectId, artifactId, message)
  },
  workspace: {
    list: (scope) => ipcRenderer.invoke('workspace:list', scope),
    grant: (scope) => ipcRenderer.invoke('workspace:grant', scope),
    pickFiles: (scope) => ipcRenderer.invoke('workspace:pick-files', scope),
    grantPaths: (scope, paths) => ipcRenderer.invoke('workspace:grant-paths', scope, paths),
    /**
     * 取拖进来的 File 的真实磁盘路径。
     *
     * Electron 32 起 File.path 被移除了(它本来就是个违反 Web 标准的扩展),
     * 只能走 webUtils,而 webUtils 只在 preload 里有——渲染进程直接调不到。
     * 这是拖拽文件这条路唯一的取路径手段。
     */
    pathOf: (file) => webUtils.getPathForFile(file),
    revoke: (id) => ipcRenderer.invoke('workspace:revoke', id)
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
    importAsset: (filePath) => ipcRenderer.invoke('storage:import-asset', filePath),
    importImage: (input) => ipcRenderer.invoke('storage:import-image', input)
  },
  sync: {
    getConfig: () => ipcRenderer.invoke('sync:get-config'),
    setConfig: (input) => ipcRenderer.invoke('sync:set-config', input)
  },
  mcp: {
    list: () => ipcRenderer.invoke('mcp:list'),
    upsert: (name, input) => ipcRenderer.invoke('mcp:upsert', name, input),
    setEnabled: (name, enabled) => ipcRenderer.invoke('mcp:set-enabled', name, enabled),
    remove: (name) => ipcRenderer.invoke('mcp:delete', name),
    importJson: (json) => ipcRenderer.invoke('mcp:import-json', json)
  },
  skill: {
    create: (name) => ipcRenderer.invoke('skill:create', name),
    installMarket: (id) => ipcRenderer.invoke('skill:install-market', id),
    remove: (name) => ipcRenderer.invoke('skill:delete', name),
    // 可选 zipPath 供自动化测试直传,UI 侧不传则由主进程弹文件框
    importPackage: (zipPath?: string) => ipcRenderer.invoke('skill:import-package', zipPath),
    tree: (name) => ipcRenderer.invoke('skill:tree', name),
    readFile: (name, path) => ipcRenderer.invoke('skill:read-file', name, path),
    writeFile: (name, path, content) => ipcRenderer.invoke('skill:write-file', name, path, content),
    mkdir: (name, path) => ipcRenderer.invoke('skill:mkdir', name, path),
    removeEntry: (name, path) => ipcRenderer.invoke('skill:remove-entry', name, path)
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
