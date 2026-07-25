import { ipcMain, nativeTheme } from 'electron'
import type { AppConfig } from '../config'
import { patchConfig, readConfig } from '../config'
import {
  createMcpServer,
  deleteMcpServer,
  importMcpJson,
  listMcpServers,
  updateMcpServer
} from '../db/repo/mcp'
import { createSkill, deleteSkill, listSkills, updateSkill } from '../db/repo/skill'
import { importSkillPackage } from '../skill-import'
import type {
  CreateProjectInput,
  CreateProviderInput,
  FetchModelsInput,
  McpServerInput,
  ModelSelection,
  Provider,
  SkillInput
} from '../../shared/types'
import {
  createProject,
  deleteProject,
  getProject,
  listProjects,
  renameProject
} from '../db/repo/project'
import { ensureDesignConversation } from '../db/repo/conversation'
import {
  clearProviderKey,
  createProvider,
  deleteProvider,
  listProviders,
  setProviderKey,
  updateProvider
} from '../db/repo/provider'
import { listModels, setModelSelection } from '../db/repo/model'
import { listMessages } from '../db/repo/message'
import { testProvider } from '../ai/registry'
import { fetchRemoteModels } from '../ai/model-catalog'
import { abortChat, sendChat } from '../ai/chat-service'
import { getArtifactFiles, listArtifacts } from '../db/repo/artifact'
import { exportArtifact } from '../artifact-export'
import { importAsset, testStorage } from '../storage/service'
import {
  dataBackendView,
  setDataBackendConfig,
  setStorageConfig,
  storageView
} from '../services-config'
import type { DataBackendInput, SendChatInput, StorageConfigInput } from '../../shared/types'

/**
 * 统一注册 IPC。
 *
 * 约定：需要返回值的一律用 handle/invoke，通道名带命名空间。
 * 只暴露领域方法，不暴露原始 SQL 和文件路径。
 */
export function registerIpc(): void {
  // preload 在加载时同步取一次初始配置，渲染进程首帧就能拿到正确的
  // 主题和语言，不用等异步 IPC 回来再纠正一次
  ipcMain.on('config:read-sync', (e) => {
    e.returnValue = readConfig()
  })

  ipcMain.handle('config:read', () => readConfig())

  ipcMain.handle('config:patch', (_e, patch: Partial<AppConfig>) => {
    const next = patchConfig(patch)
    // 毛玻璃的明暗跟随系统外观，不跟应用内开关，得同步过去
    nativeTheme.themeSource = next.dark ? 'dark' : 'light'
    return next
  })

  ipcMain.handle('project:list', () => listProjects())
  ipcMain.handle('project:get', (_e, id: string) => getProject(id))
  ipcMain.handle('project:create', (_e, input: CreateProjectInput) => {
    const project = createProject(input)
    // 一期一个项目一条 design 主会话,建项目时就绪,工作台直接可用
    ensureDesignConversation(project.id)
    return project
  })
  ipcMain.handle('project:rename', (_e, id: string, name: string) => renameProject(id, name))
  ipcMain.handle('project:delete', (_e, id: string) => deleteProject(id))

  ipcMain.handle('conversation:ensure-design', (_e, projectId: string) =>
    ensureDesignConversation(projectId)
  )

  ipcMain.handle('provider:list', () => listProviders())
  ipcMain.handle('provider:set-key', (_e, id: string, apiKey: string) => setProviderKey(id, apiKey))
  ipcMain.handle('provider:clear-key', (_e, id: string) => clearProviderKey(id))
  ipcMain.handle(
    'provider:update',
    (_e, id: string, patch: Partial<Pick<Provider, 'name' | 'baseUrl' | 'enabled'>>) =>
      updateProvider(id, patch)
  )
  ipcMain.handle('provider:create', (_e, input: CreateProviderInput) => createProvider(input))
  ipcMain.handle('provider:delete', (_e, id: string) => deleteProvider(id))
  ipcMain.handle('provider:test', (_e, id: string, modelId?: string) => testProvider(id, modelId))
  ipcMain.handle('provider:fetch-models', (_e, input: FetchModelsInput) => fetchRemoteModels(input))

  ipcMain.handle('model:list', (_e, providerId?: string) => listModels(providerId))
  ipcMain.handle('model:set-selection', (_e, providerId: string, selections: ModelSelection[]) =>
    setModelSelection(providerId, selections)
  )

  ipcMain.handle('chat:list-messages', (_e, conversationId: string) => listMessages(conversationId))
  // sender 从事件对象上取:流式增量必须发回发起请求的那个窗口
  ipcMain.handle('chat:send', (e, input: SendChatInput) => sendChat(e.sender, input))
  ipcMain.handle('chat:abort', (_e, streamId: string) => abortChat(streamId))

  ipcMain.handle('artifact:list', (_e, projectId: string) => listArtifacts(projectId))
  ipcMain.handle('artifact:files', (_e, artifactId: string) => getArtifactFiles(artifactId))
  ipcMain.handle('artifact:export', (_e, artifactId: string) => exportArtifact(artifactId))

  ipcMain.handle('storage:get-config', () => storageView())
  ipcMain.handle('storage:set-config', (_e, input: StorageConfigInput) => setStorageConfig(input))
  ipcMain.handle('storage:test', (_e, input: StorageConfigInput) => testStorage(input))
  ipcMain.handle('storage:import-asset', (_e, filePath: string) => importAsset(filePath))

  ipcMain.handle('sync:get-config', () => dataBackendView())
  ipcMain.handle('sync:set-config', (_e, input: DataBackendInput) => setDataBackendConfig(input))

  ipcMain.handle('mcp:list', () => listMcpServers())
  ipcMain.handle('mcp:create', (_e, input: McpServerInput) => createMcpServer(input))
  ipcMain.handle(
    'mcp:update',
    (_e, id: string, patch: Partial<McpServerInput> & { enabled?: boolean }) =>
      updateMcpServer(id, patch)
  )
  ipcMain.handle('mcp:delete', (_e, id: string) => deleteMcpServer(id))
  ipcMain.handle('mcp:import-json', (_e, json: string) => importMcpJson(json))

  ipcMain.handle('skill:list', () => listSkills())
  ipcMain.handle('skill:create', (_e, input: SkillInput) => createSkill(input))
  ipcMain.handle(
    'skill:update',
    (_e, id: string, patch: Partial<SkillInput> & { enabled?: boolean }) => updateSkill(id, patch)
  )
  ipcMain.handle('skill:delete', (_e, id: string) => deleteSkill(id))
  ipcMain.handle('skill:import-package', (_e, zipPath?: string) => importSkillPackage(zipPath))
}
