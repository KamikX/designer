import { installLibrary, listLibraries, updateLibrary, removeLibrary } from '../libraries/service'
import { translate } from '../../shared/i18n'
import { dialog, ipcMain, nativeTheme } from 'electron'
import { ulid } from 'ulid'
import type { AppConfig } from '../config'
import { patchConfig, readConfig } from '../config'
import { importMcpText, listMcpViews, removeMcp, setMcpEnabled, upsertMcp } from '../mcp/service'
import { importSkillPackage } from '../skill-import'
import {
  createSkillPackage,
  installSkillContent,
  mkdirSkill,
  readSkillFile,
  removeSkillEntry,
  removeSkillPackage,
  skillTree,
  writeSkillFile
} from '../skills/files'
import type {
  CreateProjectInput,
  InstallLibraryInput,
  ExternalLibraryRef,
  CreateGroupInput,
  CreateProviderInput,
  UpdateGroupInput,
  FetchModelsInput,
  McpServerInput,
  ModelSelection,
  PreviewLib,
  SessionSettings,
  Provider,
  VisualGuidance
} from '../../shared/types'
import {
  createProject,
  deleteProject,
  getProject,
  listProjects,
  renameProject,
  saveProjectSettings,
  setProjectLibs,
  setProjectExternalLibraries,
  setProjectStyleBrief,
  setProjectVisualGuidance
} from '../db/repo/project'
import {
  createChat,
  createGroup,
  deleteConversation,
  ensureDesignConversation,
  getConversation,
  listChats,
  listGroups,
  renameConversation,
  saveConversationSettings,
  updateGroup
} from '../db/repo/conversation'
import { abortGroup, isGroupChainRunning, sendGroupMessage } from '../ai/group-service'
import { exportGroupDeliverables } from '../group-export'
import { normalizeGroupMembers } from '../../shared/group-members'
import { clearUsage, getRunDiagnostics, queryDailyUsage } from '../db/repo/ai-observability'
import type { RunDiagnostics, UsageQuery, UsageReport } from '../../shared/types'
import { createGroupMembers, updateGroupMembers } from '../ai/group-members'
import { roleTemplates } from '../ai/prompts/group-roles'
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
import { answerQuestion } from '../ai/ask-user'
import { catalog, marketStatus } from '../market'
import { scanSkills } from '../skills/scan'
import { addRoot, grantPaths, listRoots, removeRoot } from '../workspace/roots'
import type { RootScope } from '../workspace/roots'
import { clearPreviewError, reportPreviewError } from '../preview/errors'
import { getArtifactFiles, listArtifacts } from '../db/repo/artifact'
import { exportArtifact } from '../artifact-export'
import { importAsset, importImage, testStorage } from '../storage/service'
import {
  dataBackendView,
  setDataBackendConfig,
  setStorageConfig,
  storageView
} from '../services-config'
import type {
  AskUserAnswer,
  DataBackendInput,
  GroupSendInput,
  ImportImageInput,
  SendChatInput,
  StorageConfigInput
} from '../../shared/types'

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

  ipcMain.handle('libraries:list', () => listLibraries())
  ipcMain.handle('libraries:install', (event, input: InstallLibraryInput) =>
    installLibrary(input, (progress) => {
      if (!event.sender.isDestroyed()) event.sender.send('libraries:progress', progress)
    })
  )
  ipcMain.handle(
    'libraries:update',
    (_event, ref: ExternalLibraryRef, patch: { description: string; instructions: string }) =>
      updateLibrary(ref, patch)
  )
  ipcMain.handle('libraries:remove', (_event, ref: ExternalLibraryRef) =>
    removeLibrary(ref, listProjects())
  )
  ipcMain.handle(
    'project:set-external-libraries',
    (_event, id: string, refs: ExternalLibraryRef[]) => setProjectExternalLibraries(id, refs)
  )

  ipcMain.handle('project:list', () => listProjects())
  ipcMain.handle('project:get', (_e, id: string) => getProject(id))
  ipcMain.handle('project:create', (_e, input: CreateProjectInput) => {
    const project = createProject(input)
    // 一期一个项目一条 design 主会话,建项目时就绪,工作台直接可用
    ensureDesignConversation(project.id)
    return project
  })
  ipcMain.handle('project:rename', (_e, id: string, name: string) => renameProject(id, name))
  ipcMain.handle('project:set-libs', (_e, id: string, libs: PreviewLib[]) =>
    setProjectLibs(id, libs)
  )
  ipcMain.handle('project:set-style-brief', (_e, id: string, styleBrief: string) =>
    setProjectStyleBrief(id, styleBrief)
  )
  ipcMain.handle('project:set-visual-guidance', (_e, id: string, guidance: VisualGuidance) =>
    setProjectVisualGuidance(id, guidance)
  )
  ipcMain.handle('project:delete', (_e, id: string) => deleteProject(id))
  ipcMain.handle('project:save-settings', (_e, id: string, patch: SessionSettings) =>
    saveProjectSettings(id, patch)
  )

  ipcMain.handle('market:skills', () => catalog().skills())
  ipcMain.handle('market:status', () => marketStatus())
  // 文件系统里已装的技能,市场里按来源分组显示
  ipcMain.handle('market:installed-skills', () => scanSkills())
  ipcMain.handle('market:mcp', () => catalog().mcp())

  // 多 agent 协作群组
  ipcMain.handle('group:roles', () => roleTemplates())
  ipcMain.handle('group:list', () => listGroups())
  ipcMain.handle('group:create', (_e, input: CreateGroupInput) => {
    if (input == null || typeof input.name !== 'string' || !input.name.trim()) {
      throw new Error('群组名称不能为空')
    }
    const members = createGroupMembers(input.members, {
      models: listModels(),
      skills: scanSkills(),
      createId: ulid
    })
    return createGroup({ name: input.name.trim(), members })
  })
  ipcMain.handle('group:update', (_e, input: UpdateGroupInput) => {
    if (input == null || typeof input.id !== 'string') throw new Error('群组不存在')
    if (typeof input.name !== 'string' || !input.name.trim()) {
      throw new Error('群组名称不能为空')
    }
    const conversation = getConversation(input.id)
    if (!conversation || conversation.kind !== 'group') throw new Error('群组不存在')
    // 每一棒开始时都重读成员配置,链跑一半改配置=中途换人设
    if (isGroupChainRunning(input.id)) {
      throw new Error('接力进行中,先等它结束或点停止,再修改群组配置。')
    }
    const members = updateGroupMembers(
      normalizeGroupMembers(conversation.settings?.members),
      input.members,
      { models: listModels(), skills: scanSkills(), createId: ulid }
    )
    return updateGroup({ id: input.id, name: input.name.trim(), members })
  })
  ipcMain.handle('group:rename', (_e, id: string, name: string) => renameConversation(id, name))
  ipcMain.handle('group:delete', (_e, id: string) => deleteConversation(id))
  ipcMain.handle('group:messages', (_e, id: string) => listMessages(id))
  ipcMain.handle('group:send', (e, input: GroupSendInput) => sendGroupMessage(e.sender, input))
  ipcMain.handle('group:abort', (_e, id: string) => abortGroup(id))
  ipcMain.handle('group:export', (_e, id: string) => exportGroupDeliverables(id))

  ipcMain.handle('chat:list', () => listChats())
  ipcMain.handle('chat:create', () => createChat())
  ipcMain.handle('chat:rename', (_e, id: string, title: string) => renameConversation(id, title))
  ipcMain.handle('chat:delete', (_e, id: string) => deleteConversation(id))
  ipcMain.handle('chat:save-settings', (_e, id: string, patch: SessionSettings) =>
    saveConversationSettings(id, patch)
  )

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
  /*
   * 可观测性:只读查询 + 一个受控清除。渲染层拿不到 SQL,也改不了追踪行。
   * 查询参数来自渲染进程,一律当不可信输入——仓储侧全部走参数绑定。
   */
  ipcMain.handle(
    'observability:run-for-message',
    (_e, messageId: string): RunDiagnostics | null => {
      if (typeof messageId !== 'string' || !messageId) return null
      const record = getRunDiagnostics(messageId)
      // 仓储行是诊断表的超集(多 id/createdAt 等快照列),结构上满足共享契约
      return record ? (record as unknown as RunDiagnostics) : null
    }
  )
  ipcMain.handle('observability:usage', (_e, query: UsageQuery): UsageReport => {
    const q = query && typeof query === 'object' ? query : {}
    return {
      rows: queryDailyUsage({
        ...(typeof q.from === 'string' ? { from: q.from } : {}),
        ...(typeof q.to === 'string' ? { to: q.to } : {}),
        ...(typeof q.providerKey === 'string' ? { providerKey: q.providerKey } : {}),
        ...(typeof q.modelId === 'string' ? { modelId: q.modelId } : {}),
        ...(typeof q.scene === 'string' ? { scene: q.scene } : {}),
        ...(typeof q.projectKey === 'string' ? { projectKey: q.projectKey } : {})
      }) as unknown as UsageReport['rows']
    }
  })
  ipcMain.handle('observability:clear-usage', () => clearUsage())

  ipcMain.handle('chat:send', (e, input: SendChatInput) => sendChat(e.sender, input))
  ipcMain.handle('chat:abort', (_e, streamId: string) => abortChat(streamId))
  // 提问的答案:主进程侧 resolve 掉那个挂着的工具调用,循环继续往下跑
  ipcMain.handle('chat:answer-question', (_e, questionId: string, answer: AskUserAnswer) => {
    answerQuestion(questionId, answer)
  })

  ipcMain.handle(
    'preview:report-error',
    (_e, projectId: string, artifactId: string, message: string) => {
      reportPreviewError(projectId, artifactId, message)
    }
  )

  ipcMain.handle('preview:clear-error', (_e, projectId: string, artifactId: string) => {
    clearPreviewError(projectId, artifactId)
  })

  ipcMain.handle('workspace:list', (_e, scope: RootScope) => listRoots(scope))
  ipcMain.handle('workspace:grant', async (_e, scope: RootScope) => {
    const res = await dialog.showOpenDialog({
      title: translate(readConfig().lang, '选择要让 AI 参考的本地目录'),
      message: translate(readConfig().lang, 'AI 将能读取该目录下的文件用于分析;范围之外一律不可见'),
      properties: ['openDirectory']
    })
    if (res.canceled || res.filePaths.length === 0) return null
    return addRoot(scope, res.filePaths[0])
  })
  // 选文件(不是目录)。和上面共用一套授权,只是入口不同:拖拽进来的
  // 走 grant-paths,点"+ 文件"的走这里
  ipcMain.handle('workspace:pick-files', async (_e, scope: RootScope) => {
    const res = await dialog.showOpenDialog({
      title: translate(readConfig().lang, '选择要让 AI 参考的文件'),
      message: translate(readConfig().lang, 'AI 将能读取这些文件用于分析;其余文件一律不可见'),
      properties: ['openFile', 'multiSelections']
    })
    if (res.canceled || res.filePaths.length === 0) return { granted: [], rejected: [] }
    return grantPaths(scope, res.filePaths)
  })
  ipcMain.handle('workspace:grant-paths', (_e, scope: RootScope, paths: string[]) =>
    grantPaths(scope, paths)
  )
  ipcMain.handle('workspace:revoke', (_e, id: string) => removeRoot(id))

  ipcMain.handle('artifact:list', (_e, projectId: string) => listArtifacts(projectId))
  ipcMain.handle('artifact:files', (_e, artifactId: string) => getArtifactFiles(artifactId))
  ipcMain.handle('artifact:export', (_e, artifactId: string) => exportArtifact(artifactId))

  ipcMain.handle('storage:get-config', () => storageView())
  ipcMain.handle('storage:set-config', (_e, input: StorageConfigInput) => setStorageConfig(input))
  ipcMain.handle('storage:test', (_e, input: StorageConfigInput) => testStorage(input))
  ipcMain.handle('storage:import-asset', (_e, filePath: string) => importAsset(filePath))
  // 拖拽 / 粘贴 / 选文件三种来源统一走字节:粘贴的截图根本没有路径
  ipcMain.handle('storage:import-image', (_e, input: ImportImageInput) =>
    importImage({ name: input.name, mime: input.mime, data: Buffer.from(input.data) })
  )

  ipcMain.handle('sync:get-config', () => dataBackendView())
  ipcMain.handle('sync:set-config', (_e, input: DataBackendInput) => setDataBackendConfig(input))

  // MCP:mcp.json 是唯一事实来源,身份即名字
  ipcMain.handle('mcp:list', () => listMcpViews())
  ipcMain.handle('mcp:upsert', (_e, name: string, input: McpServerInput) => upsertMcp(name, input))
  ipcMain.handle('mcp:set-enabled', (_e, name: string, enabled: boolean) =>
    setMcpEnabled(name, enabled)
  )
  ipcMain.handle('mcp:delete', (_e, name: string) => removeMcp(name))
  ipcMain.handle('mcp:import-json', (_e, json: string) => importMcpText(json))

  // 「我的技能」:全部落在 ~/.antd-designer/skills,身份即目录名
  ipcMain.handle('skill:create', (_e, name: string) => createSkillPackage(name))
  ipcMain.handle('skill:install-market', async (_e, id: string) => {
    const entry = (await catalog().skills()).find((s) => s.id === id)
    if (!entry) throw new Error('市场里没有这个技能')
    return installSkillContent(entry.name, entry.description, entry.content)
  })
  ipcMain.handle('skill:delete', (_e, name: string) => removeSkillPackage(name))
  ipcMain.handle('skill:import-package', (_e, zipPath?: string) => importSkillPackage(zipPath))
  ipcMain.handle('skill:tree', (_e, name: string) => skillTree(name))
  ipcMain.handle('skill:read-file', (_e, name: string, rel: string) => readSkillFile(name, rel))
  ipcMain.handle('skill:write-file', (_e, name: string, rel: string, content: string) =>
    writeSkillFile(name, rel, content)
  )
  ipcMain.handle('skill:mkdir', (_e, name: string, rel: string) => mkdirSkill(name, rel))
  ipcMain.handle('skill:remove-entry', (_e, name: string, rel: string) =>
    removeSkillEntry(name, rel)
  )
}
