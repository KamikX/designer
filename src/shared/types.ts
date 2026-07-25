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

/** 设计稿产物技术栈，项目创建时三选一，之后不可改 */
export type Stack = 'html' | 'vue3' | 'react'

/** 设计模式：高质量 UI 设计 / 快速原型（原型的差异化二期细化） */
export type DesignMode = 'design' | 'prototype'

export interface Project {
  id: string
  name: string
  stack: Stack
  designMode: DesignMode
  description: string
  createdAt: string
  updatedAt: string
}

export interface CreateProjectInput {
  name: string
  stack: Stack
  designMode: DesignMode
  description?: string
}

export interface Conversation {
  id: string
  projectId: string
  title: string
  /** 'design' 主设计会话;二期问答模式为 'qa' */
  kind: 'design' | 'qa'
  createdAt: string
  updatedAt: string
}

/**
 * 消息内容分片。assistant 生成的文件正文不存在 parts 里(在
 * artifact_files),这里只留 file 引用——历史回放时天然不带旧文件体。
 */
export type MessagePart =
  { type: 'text'; text: string } | { type: 'file'; path: string; action: 'write' | 'delete' }

export interface ChatUsage {
  inputTokens: number
  outputTokens: number
}

export interface Message {
  id: string
  conversationId: string
  role: 'user' | 'assistant' | 'system'
  parts: MessagePart[]
  status: 'complete' | 'streaming' | 'error' | 'aborted'
  usage: ChatUsage | null
  providerSlug: string | null
  modelId: string | null
  artifactId: string | null
  createdAt: string
}

export interface Artifact {
  id: string
  projectId: string
  messageId: string | null
  /** 项目内递增版本号 */
  version: number
  baseArtifactId: string | null
  summary: string
  createdAt: string
}

export interface ArtifactFile {
  path: string
  content: string
}

export interface SendChatInput {
  conversationId: string
  text: string
  providerId: string
  modelId: string
}

export interface SendChatResult {
  streamId: string
  userMessageId: string
  assistantMessageId: string
}

/**
 * 流式事件,单通道 + streamId 路由。二期加成员即可(如 image-progress),
 * 通道与分发机制不动。
 */
export type ChatStreamEvent = { streamId: string } & (
  | { type: 'delta'; text: string }
  | { type: 'file-start'; path: string }
  | { type: 'file-delta'; path: string; text: string }
  | { type: 'file-end'; path: string }
  | { type: 'file-delete'; path: string }
  | { type: 'usage'; usage: ChatUsage }
  | { type: 'done'; messageId: string; artifactId: string | null }
  | { type: 'error'; message: string }
)

/** 决定主进程用哪个 AI SDK 工厂创建模型实例 */
export type AdapterType = 'openai' | 'anthropic' | 'google' | 'deepseek' | 'openai-compatible'

/**
 * 供应商的对外形态。刻意不含密钥密文字段——渲染进程只能知道
 * "有没有密钥"和脱敏提示，密文和明文都永不过 IPC。
 */
export interface Provider {
  id: string
  slug: string
  name: string
  adapter: AdapterType
  baseUrl: string | null
  hasKey: boolean
  /** 'plain' 表示该系统无安全存储，密钥明文保存，UI 要警告 */
  keyStorage: 'safe' | 'plain'
  keyHint: string | null
  enabled: boolean
  isBuiltin: boolean
  createdAt: string
  updatedAt: string
}

/**
 * 模型类型(单值,按模型定):决定它出现在哪个功能里。
 * chat 对话 / image 绘图 / embedding 向量 / rerank 重排 /
 * tts 语音合成 / stt 语音识别
 */
export type ModelType = 'chat' | 'image' | 'embedding' | 'rerank' | 'tts' | 'stt'

/**
 * 对话类模型的能力(多选):vision 识图(图片输入)/
 * files 文件识别(文档输入)/ tools 工具调用(function calling)。
 * 非 chat 类型的模型能力恒为空。
 */
export type ModelAbility = 'vision' | 'files' | 'tools'

export interface Model {
  id: string
  providerId: string
  modelId: string
  displayName: string
  type: ModelType
  abilities: ModelAbility[]
  contextWindow: number
  enabled: boolean
  isBuiltin: boolean
  sortOrder: number
}

export interface CreateModelInput {
  providerId: string
  modelId: string
  displayName?: string
  type?: ModelType
  abilities?: ModelAbility[]
  contextWindow?: number
}

/** 从供应商 API 拉到的可用模型(未入库,仅供勾选) */
export interface RemoteModel {
  modelId: string
  displayName: string
}

/** 配置抽屉保存时对单个模型的完整描述 */
export interface ModelSelection {
  modelId: string
  displayName?: string
  /** 缺省时主进程按模型名推断 */
  type?: ModelType
  abilities?: ModelAbility[]
  contextWindow?: number
}

/**
 * 拉取远程模型列表的参数。providerId 存在时,缺省的 baseUrl/apiKey
 * 用该供应商已保存的配置补齐(密钥不回传渲染进程,主进程内部解密)。
 */
export interface FetchModelsInput {
  adapter: AdapterType
  providerId?: string
  baseUrl?: string | null
  apiKey?: string
}

export interface CreateProviderInput {
  name: string
  adapter: AdapterType
  baseUrl?: string
  apiKey?: string
}

export interface ProviderTestResult {
  ok: boolean
  latencyMs?: number
  error?: string
}

/* ------------------------------------------------------------------ */
/* MCP 服务与技能                                                      */
/* ------------------------------------------------------------------ */

export type McpTransport = 'stdio' | 'sse' | 'http'

export interface McpServer {
  id: string
  name: string
  transport: McpTransport
  /** stdio:启动命令与参数 */
  command: string | null
  args: string[]
  env: Record<string, string>
  /** sse / http:远程端点 */
  url: string | null
  headers: Record<string, string>
  enabled: boolean
  createdAt: string
  updatedAt: string
}

export interface McpServerInput {
  name: string
  transport: McpTransport
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
  headers?: Record<string, string>
}

/** 技能:可复用的提示词包,启用后注入设计对话 */
export interface Skill {
  id: string
  name: string
  description: string
  content: string
  enabled: boolean
  createdAt: string
  updatedAt: string
}

export interface SkillInput {
  name: string
  description?: string
  content: string
}

/* ------------------------------------------------------------------ */
/* 数据后端与对象存储(密文永不出主进程:读取形只有 has* 掩码)          */
/* ------------------------------------------------------------------ */

export type StorageMode = 'local' | 's3'

export interface S3ConfigView {
  endpoint: string
  region: string
  bucket: string
  accessKey: string
  hasSecret: boolean
  publicBaseUrl: string
  forcePathStyle: boolean
}

export interface StorageConfigView {
  mode: StorageMode
  s3: S3ConfigView | null
}

/** 写入形:secretKey 缺省表示沿用已存密文 */
export interface StorageConfigInput {
  mode: StorageMode
  s3?: {
    endpoint: string
    region?: string
    bucket: string
    accessKey: string
    secretKey?: string
    publicBaseUrl?: string
    forcePathStyle?: boolean
  }
}

/** 'cloud' 为未来官方云服务预留,本期 UI 置灰 */
export type DataBackendMode = 'local' | 'self-hosted' | 'cloud'

export interface SelfHostedDbView {
  dialect: 'mysql' | 'postgres'
  host: string
  port: number
  database: string
  user: string
  hasPassword: boolean
  ssl: boolean
}

export interface DataBackendView {
  mode: DataBackendMode
  selfHosted: SelfHostedDbView | null
}

export interface DataBackendInput {
  mode: DataBackendMode
  selfHosted?: {
    dialect: 'mysql' | 'postgres'
    host: string
    port: number
    database: string
    user: string
    password?: string
    ssl?: boolean
  }
}

export interface AssetRef {
  id: string
  uri: string
  mime: string
  size: number
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
    get: (id: string) => Promise<Project | null>
    create: (input: CreateProjectInput) => Promise<Project>
    rename: (id: string, name: string) => Promise<Project | null>
    remove: (id: string) => Promise<void>
  }
  conversation: {
    /** 项目的 design 主会话,不存在则自动创建 */
    ensureDesign: (projectId: string) => Promise<Conversation>
  }
  chat: {
    listMessages: (conversationId: string) => Promise<Message[]>
    send: (input: SendChatInput) => Promise<SendChatResult>
    abort: (streamId: string) => Promise<void>
    /** 订阅流式事件,返回取消订阅函数。整个应用只应有一个订阅者(chat store) */
    onStream: (cb: (event: ChatStreamEvent) => void) => () => void
  }
  artifact: {
    list: (projectId: string) => Promise<Artifact[]>
    files: (artifactId: string) => Promise<ArtifactFile[]>
    /** 弹目录选择框导出整棵文件树,返回导出目录;用户取消返回 null */
    exportTo: (artifactId: string) => Promise<string | null>
  }
  provider: {
    list: () => Promise<Provider[]>
    /** 单向写入。没有任何"读回明文"的通道 */
    setKey: (id: string, apiKey: string) => Promise<Provider>
    clearKey: (id: string) => Promise<Provider>
    update: (
      id: string,
      patch: Partial<Pick<Provider, 'name' | 'baseUrl' | 'enabled'>>
    ) => Promise<Provider | null>
    /** 新增供应商:选定适配类型 + baseUrl + key */
    create: (input: CreateProviderInput) => Promise<Provider>
    /** 只允许删自定义供应商，内置的用 enabled 关掉 */
    remove: (id: string) => Promise<void>
    /** 用真实请求测连通性（需要该供应商至少有一个启用的 chat 模型） */
    test: (id: string, modelId?: string) => Promise<ProviderTestResult>
    /** 调供应商的 /models 端点拉取可用模型列表 */
    fetchModels: (input: FetchModelsInput) => Promise<RemoteModel[]>
  }
  model: {
    list: (providerId?: string) => Promise<Model[]>
    /**
     * 按勾选结果整定某供应商的模型:勾选的确保存在且启用(能力/上下文
     * 以传入为准),未勾选的已有行置为停用(不删,保住用户配置)
     */
    setSelection: (providerId: string, selections: ModelSelection[]) => Promise<Model[]>
  }
  storage: {
    getConfig: () => Promise<StorageConfigView>
    setConfig: (input: StorageConfigInput) => Promise<StorageConfigView>
    /** 用传入参数实测(写读删一个测试对象),不动已存配置 */
    test: (input: StorageConfigInput) => Promise<ProviderTestResult>
    /** 导入本地文件为资源,返回 asset:// 引用 */
    importAsset: (filePath: string) => Promise<AssetRef>
  }
  sync: {
    getConfig: () => Promise<DataBackendView>
    setConfig: (input: DataBackendInput) => Promise<DataBackendView>
  }
  mcp: {
    list: () => Promise<McpServer[]>
    create: (input: McpServerInput) => Promise<McpServer>
    update: (
      id: string,
      patch: Partial<McpServerInput> & { enabled?: boolean }
    ) => Promise<McpServer | null>
    remove: (id: string) => Promise<void>
    /** 导入标准 mcpServers JSON(Claude Desktop / Cursor 同款格式),返回新增列表 */
    importJson: (json: string) => Promise<McpServer[]>
  }
  skill: {
    list: () => Promise<Skill[]>
    create: (input: SkillInput) => Promise<Skill>
    update: (
      id: string,
      patch: Partial<SkillInput> & { enabled?: boolean }
    ) => Promise<Skill | null>
    remove: (id: string) => Promise<void>
    /** 弹文件框导入技能压缩包(必须包含 SKILL.md);用户取消返回 null */
    importPackage: () => Promise<Skill | null>
  }
}
