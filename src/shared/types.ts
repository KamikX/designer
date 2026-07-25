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
  /**
   * 全局辅助模型:长文档超过阈值时,先用它压成"设计要用的提炼稿"再交给
   * 主模型。挑一个便宜的即可——它做的是信息抽取,不是设计。
   * 没配就跳过提炼,直接把截断后的原文给主模型。
   */
  assistantModel: { providerId: string; modelId: string } | null
  /**
   * 搜索 API 备用来源。默认不配——联网搜索走 Electron 无头浏览器,开箱即用。
   *
   * 只在浏览器那条路**被反爬拦住**时才动用,不是"配了就优先用":那会白白
   * 消耗用户的配额,而多数时候浏览器那条是好使的。
   */
  searchApi: { provider: 'brave' | 'tavily'; key: string } | null
  /**
   * 应用市场源地址。指向一个 JSON 端点,形如
   * `{ "skills": MarketSkill[], "mcp": MarketMcp[] }`(两个键都可缺省)。
   *
   * 空串表示没配——市场页就是空的。清单不再内置在应用里:
   * 内容更新不该跟着应用发版走,谁维护清单也不该由代码写死。
   */
  marketUrl: string
  /**
   * OpenAI 协议的兼容开关。中转站行为各不相同,这里留给用户手改
   * (~/.antd-designer/config.json),不用重新打包就能试。
   */
  openaiCompat: {
    /**
     * 是否让服务端保存对话项(Responses API 的 store)。
     *
     * **默认 false,不要轻易改回 true。** store=true 时模型的 reasoning 存在
     * 服务端、下一步只回传 `rs_xxx` 引用;而中转站会把两次请求分发到不同的
     * 上游实例,第二次就找不到这个 id:
     *
     *   Item with id 'rs_...' not found.
     *
     * 只在多步工具调用时出现——单轮对话没有回传环节。
     */
    store: boolean
    /**
     * 是否要求返回加密的 reasoning,以便跨步骤原样带回。
     *
     * **默认 false。** 开了能让模型在多步之间保住自己的思考过程,质量更好;
     * 但这是标准 OpenAI API 的特性,**基于 Codex 后端的中转站往往不支持**,
     * 而且不认识的选项常常换来一个 500 server_error 而不是干净的 400。
     *
     * 直连 OpenAI、或确认中转站支持时再打开。
     */
    encryptedReasoning: boolean
  }
}

/** 设计稿产物技术栈，项目创建时三选一，之后不可改 */
export type Stack = 'html' | 'vue3' | 'react'

/** 设计模式：高质量 UI 设计 / 快速原型（原型的差异化二期细化） */
export type DesignMode = 'design' | 'prototype'

/**
 * 设计端类型,创建项目时多选。
 *
 * 它决定两件事:注入哪套端契约(不可妥协的交付标准)和哪份端设计模板
 * (archetype 路由 + 提问清单 + 自查项)。**只加载勾选的端**——不勾的端
 * 的模板留在技能目录里按需激活,不占常驻上下文。
 *
 * mobile 移动端 App / web PC Web 应用 / landing 营销落地页 / admin 中后台
 */
export type DesignTarget = 'mobile' | 'web' | 'landing' | 'admin'

/**
 * 预览环境可加载的组件库(CDN / vendor 的浏览器 ESM 构建)。
 * 目前只对 vue3 栈开放:antdv-next 组件库与它的图标包。
 */
export type PreviewLib = 'antdv-next' | '@antdv-next/icons'

/**
 * "上次选了什么"。设计项目和纯聊天各存各的。
 *
 * 为什么不做成全局单值:不同项目本来就该配不同的模型和技能——给管理后台
 * 画图和给营销页画图,需要的技能集不一样;聊天更是如此,查资料那条会话开着
 * 联网,读代码那条不需要。全局单值会让每次切换都要重设一遍。
 *
 * 每个字段都可缺省,含义是"还没选过,按全局默认来"。注意 skillIds 的 `[]`
 * 和 `undefined` 不是一回事:前者是用户**明确一个都不要**,后者才是没选过
 * ——两者混为一谈会让"全部取消勾选"这个操作在重启后失效。
 */
export interface SessionSettings {
  providerId?: string
  modelId?: string
  /** 勾选的文件技能**名字**(技能的身份就是目录名,没有数据库 id) */
  skillIds?: string[]
  /** 勾选的 MCP 服务**名字**(mcp.json 的键) */
  mcpIds?: string[]
  /** 是否开着联网。按会话记,不是全局——不然会出现"忘了它还开着" */
  webSearch?: boolean
  /** 群组会话的成员角色 id 列表(conversations.kind='group' 时使用) */
  members?: string[]
}

/* ------------------------------------------------------------------ */
/* 多 agent 协作群组                                                    */
/* ------------------------------------------------------------------ */

/** 群组角色的展示元数据。人设提示词在主进程,渲染层只需要这些 */
export interface GroupRoleMeta {
  id: string
  name: string
  /** 头像底色 */
  color: string
  /** 一句话职责,建群勾选时看 */
  duty: string
  /** 产出物名称,如「需求列表」 */
  deliverable: string
}

/** 群组流式事件,单通道按 conversationId 路由 */
export type GroupStreamEvent = { conversationId: string } & (
  | {
      /** 某个 agent 开始干活。system 是注入给它的完整提示词,头像抽屉展示用 */
      type: 'agent-start'
      messageId: string
      author: string
      system: string
    }
  | { type: 'delta'; messageId: string; text: string }
  | { type: 'tool-start'; messageId: string; callId: string; label: string }
  | { type: 'tool-update'; messageId: string; callId: string; label: string }
  | { type: 'tool-end'; messageId: string; callId: string; ok: boolean; summary?: string }
  | { type: 'agent-done'; messageId: string }
  /** 整条接力链结束(没人再被 @,或到达上限,或用户中止) */
  | { type: 'chain-done' }
  | { type: 'error'; message: string; messageId?: string }
)

export interface GroupSendInput {
  conversationId: string
  text: string
  providerId: string
  modelId: string
}

/** @deprecated 名字留作过渡,内容与 SessionSettings 一致 */
export type ProjectSettings = SessionSettings

export interface Project {
  id: string
  name: string
  stack: Stack
  designMode: DesignMode
  /** 勾选的端类型。null / [] 表示没选(老项目或用户跳过),不注入任何端契约 */
  targets: DesignTarget[] | null
  /** 勾选的组件库。null / [] 表示纯 Tailwind,预览不加载任何组件库 */
  libs: PreviewLib[] | null
  description: string
  /** 用户定义的视觉方向；空字符串表示尚未定义 */
  styleBrief: string
  settings: SessionSettings | null
  createdAt: string
  updatedAt: string
}

export interface CreateProjectInput {
  name: string
  stack: Stack
  designMode: DesignMode
  targets?: DesignTarget[]
  libs?: PreviewLib[]
  description?: string
  styleBrief?: string
}

export interface Conversation {
  id: string
  /** 纯聊天没有项目,这里为 null */
  projectId: string | null
  title: string
  /** 'design' 项目里的设计会话 | 'chat' 独立的纯聊天 | 'group' 多 agent 协作群组 */
  kind: 'design' | 'chat' | 'group'
  /** 这条会话"上次选了什么"。纯聊天靠它记住模型 / 技能 / MCP / 联网开关 */
  settings: SessionSettings | null
  createdAt: string
  updatedAt: string
}

/* ------------------------------------------------------------------ */
/* 交互式提问(AI 动手前先跟用户确认方向)                                */
/* ------------------------------------------------------------------ */

/** 一道题的选项 */
export interface AskOption {
  label: string
  /** 选项释义,渲染成小字;帮用户判断选哪个 */
  description?: string
}

export interface AskQuestion {
  /** 极短标签(不超过 8 个字),折叠态和已答摘要里显示 */
  header: string
  question: string
  /** single 单选 / multiple 多选 */
  kind: 'single' | 'multiple'
  options: AskOption[]
  /** 允许"其他",用户可以自己填一个 */
  allowCustom?: boolean
}

/**
 * 要用户填的密钥。
 *
 * 单独一类而不是复用普通问题:它必须渲染成密码框,而且**答案不能落进消息历史**
 * ——历史会进下一轮上下文、会被同步、会出现在导出里。
 */
export interface AskSecret {
  /** 环境变量名,如 GITHUB_TOKEN */
  key: string
  label: string
  /** 去哪儿申请 */
  help?: string
}

/** ask_user 工具的入参:一次最多问 4 题,别把用户当问卷填 */
export interface AskUserInput {
  /** 一句话说明为什么要问 */
  intro?: string
  questions: AskQuestion[]
  /** 末尾的自由描述框 */
  notes?: { label: string; placeholder?: string }
  /** 要用户填的密钥。渲染成密码框,答案不入库 */
  secrets?: AskSecret[]
}

export interface AskUserAnswer {
  /** 按题序排列,每题选中的标签(自定义输入直接作为一项) */
  selections: string[][]
  /** 自由描述 */
  notes?: string
  /** 用户点了跳过 / 中止 / 超时 */
  skipped?: boolean
  /**
   * 密钥答案。**主进程收到后立刻剥离**:存进加密文件,不写进 message parts。
   * 之后这个字段在历史里永远是 undefined。
   */
  secrets?: Record<string, string>
}

/**
 * 消息内容分片。assistant 生成的文件正文不存在 parts 里(在
 * artifact_files),这里只留 file 引用——历史回放时天然不带旧文件体。
 *
 * question 分片连答案一起存:重开项目时问答卡片照常显示,而且是已答状态。
 */
export type MessagePart =
  | { type: 'text'; text: string }
  | { type: 'file'; path: string; action: 'write' | 'delete' }
  | {
      type: 'question'
      questionId: string
      ask: AskUserInput
      answer: AskUserAnswer | null
    }
  /**
   * 用户提供的参考图。**只有发出它的那一轮**会把像素喂给模型,之后的
   * 历史里只回放引用与 description——图片按尺寸计费,每轮重发一次等于
   * 每轮重付一次。模型真要再看,用 view_image 工具自己拉回来。
   *
   * description 由模型看过图之后用 note_image 写下,是"记忆"的载体:
   * 有它多数后续轮次就不必再看图了。
   */
  | {
      type: 'image'
      assetId: string
      mime: string
      name: string
      width?: number
      height?: number
      description?: string
    }

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
  /** 群组会话的发言者(角色 id / 'user');普通对话为 null */
  author?: string | null
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
  /**
   * 随本轮附上的参考图。模型需有 vision 能力,否则主进程直接拒。
   * 带上 name 是因为 assets 表只存哈希与位置,不存文件名。
   */
  attachments?: { assetId: string; name: string }[]
  /**
   * 本会话勾选的文件技能名字。
   *
   * 勾选 = 允许使用(进 L1 目录、可被 activate_skill 激活),不是全文注入。
   * 设计会话里内置技能(craft-* / target-* / design-seed)不走这里——
   * 它们按项目勾选的端自动生效;纯聊天则**只有**勾选的技能可用,默认零注入。
   */
  skillIds?: string[]
  /** 本会话勾选的 MCP 服务名字。勾选的才连接,默认一个都不连 */
  mcpIds?: string[]
  /**
   * 本轮是否开启联网搜索。默认关。
   *
   * 按轮次传而不是存成会话设置:用户是在输入框上点开关的,那是一个"这句话
   * 要不要联网"的即时决定。存成持久状态会出现"我上周开过,今天忘了它还开着"。
   */
  webSearch?: boolean
}

export interface SendChatResult {
  streamId: string
  userMessageId: string
  assistantMessageId: string
  /**
   * 本轮从用户消息里识别并自动授权的本地路径。渲染层据此刷新授权列表,
   * 让用户立刻看见"我刚才那句话让 AI 能读什么了"。
   */
  grantedRoots?: WorkspaceRoot[]
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
  /**
   * 工具协议下的局部编辑。oldText 是定位锚点,空串表示整份替换
   * (新建或全文重写)。渲染层据此就地 applyEdits,而不是重放全文。
   */
  | {
      type: 'file-patch'
      path: string
      oldText: string
      newText: string
      replaceAll?: boolean
    }
  /**
   * AI 要问用户问题,工具循环**停在这里等作答**。渲染层弹出问答卡片,
   * 用户提交后走 chat.answerQuestion 把答案送回主进程,循环才继续。
   */
  | { type: 'question'; questionId: string; ask: AskUserInput }
  /**
   * 工具调用的生命周期。没有这几个事件,工具协议下聊天框就是一片死寂:
   * 模型在调工具的那几十秒里根本不产文字,textStream 无事可吐。
   *
   * label / summary 都是主进程算好的人话短句——原始入参不出主进程,
   * write_file 的 content 是整份文件,推给渲染层既没用又贵。
   */
  | { type: 'tool-start'; callId: string; toolName: string; label: string }
  | { type: 'tool-update'; callId: string; label: string }
  | { type: 'tool-end'; callId: string; ok: boolean; summary?: string }
  /** 有思考能力的模型的思考流。本来就在计费,显示出来不额外花钱 */
  | { type: 'reasoning'; text: string }
  | { type: 'usage'; usage: ChatUsage }
  | { type: 'done'; messageId: string; artifactId: string | null }
  // artifactId:出错前工具已经改好的部分仍然会成版本(见 chat-service 的
  // keepWork),渲染层要认下来,否则那些改动存了却看不见
  | { type: 'error'; message: string; artifactId?: string | null }
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

/**
 * MCP 服务的对外形态。事实来源是 `~/.antd-designer/mcp.json`,**身份就是名字**
 * (mcp.json 的键),没有数据库 id。会话勾选也按名字存。
 */
export interface McpServerView {
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
  /** 配置里引用了、但环境变量和密钥库都给不出的 ${VAR}。界面上标出来 */
  missingEnv?: string[]
}

export interface McpServerInput {
  transport: McpTransport
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
  headers?: Record<string, string>
  enabled?: boolean
}
/* ------------------------------------------------------------------ */
/* 市场                                                                */
/* ------------------------------------------------------------------ */

/** 文件系统里已装好的技能 */
export interface InstalledSkill {
  name: string
  description: string
  /** app 本应用 | agents 跨工具共享 | claude 兼容位置 | builtin 随应用发布 */
  source: 'app' | 'agents' | 'claude' | 'builtin'
  dir: string
  /** 格式上的问题,界面上标出来但不影响加载 */
  warning?: string
}

export interface MarketSkill {
  id: string
  name: string
  description: string
  tags: string[]
  content: string
}

/** MCP 服务要用户自己补的环境变量 */
export interface EnvHint {
  key: string
  label: string
  help?: string
}

export interface MarketMcp {
  id: string
  name: string
  description: string
  tags: string[]
  transport: McpTransport
  /** stdio 类:安装确认框里要**原样展示**的命令 */
  command?: string
  args?: string[]
  url?: string
  envHints?: EnvHint[]
  homepage?: string
}

/**
 * 技能文件树节点。「我的技能」编辑器(左树右编辑器)用,
 * path 是相对技能根目录的相对路径。
 */
export interface SkillFileNode {
  name: string
  path: string
  type: 'file' | 'dir'
  children?: SkillFileNode[]
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

/**
 * 用户授权给某个项目的本地目录。本地文件工具的唯一权限来源:
 * 没有授权就没有工具,AI 连试探的入口都没有。
 */
export interface WorkspaceRoot {
  id: string
  /** 设计项目的授权。与 conversationId 恰好有一个存在 */
  projectId?: string
  /** 纯聊天的授权,跟着会话走 */
  conversationId?: string
  path: string
  name: string
}

/**
 * 授权范围的归属:设计项目 或 纯聊天会话,恰好有一个。
 *
 * 用联合类型而不是两个可选字段——后者允许"两个都传"和"都不传",
 * 而那两种都是无意义的调用,却要到运行时才发现。
 */
export type RootScope = { projectId: string } | { conversationId: string }

export interface GrantedRoot extends WorkspaceRoot {
  /** 文件还是目录。只用于界面显示,不入库 */
  isFile: boolean
}

/** 批量授权的结果。单条失败不拖垮整批,失败的原样带回来告诉用户 */
export interface GrantOutcome {
  granted: GrantedRoot[]
  rejected: { path: string; reason: string }[]
}

export interface AssetRef {
  id: string
  uri: string
  mime: string
  size: number
  /** 图片才有;缩放之后的尺寸 */
  width?: number
  height?: number
}

/** 渲染层拖拽 / 粘贴 / 选文件三种来源统一走字节,不走路径 */
export interface ImportImageInput {
  name: string
  mime: string
  data: ArrayBuffer
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
    /** 修改依赖包。libs 不牵动文件树,创建后改是安全的(影响预览装配与提示词) */
    setLibs: (id: string, libs: PreviewLib[]) => Promise<Project | null>
    remove: (id: string) => Promise<void>
    /** 合并保存工作台选择(模型/技能/MCP),只覆盖传进来的字段 */
    saveSettings: (id: string, patch: SessionSettings) => Promise<void>
  }
  conversation: {
    /** 项目的 design 主会话,不存在则自动创建 */
    ensureDesign: (projectId: string) => Promise<Conversation>
  }
  /** 技能 / MCP 市场。清单来自设置里配置的远程市场源(marketUrl),没配就是空的 */
  market: {
    skills: () => Promise<MarketSkill[]>
    mcp: () => Promise<MarketMcp[]>
    /** 市场源状态:配没配地址、最近一次拉取有没有问题 */
    status: () => Promise<{ url: string; problem?: string }>
    /** 文件系统里已装好的技能(含来源) */
    installedSkills: () => Promise<InstalledSkill[]>
  }
  /** 独立的纯聊天会话(没有项目) */
  chatSession: {
    list: () => Promise<Conversation[]>
    create: () => Promise<Conversation>
    rename: (id: string, title: string) => Promise<void>
    remove: (id: string) => Promise<void>
    /** 合并保存这条聊天的选择,只覆盖传进来的字段 */
    saveSettings: (id: string, patch: SessionSettings) => Promise<void>
  }
  /** 多 agent 协作群组(聊天室) */
  group: {
    /** 可用角色清单(内置,建群时勾选) */
    roles: () => Promise<GroupRoleMeta[]>
    list: () => Promise<Conversation[]>
    create: (name: string, members: string[]) => Promise<Conversation>
    rename: (id: string, name: string) => Promise<void>
    remove: (id: string) => Promise<void>
    messages: (conversationId: string) => Promise<Message[]>
    /** 发消息并启动 @ 接力编排;立即返回,过程走 onStream */
    send: (input: GroupSendInput) => Promise<void>
    /** 停止当前接力链 */
    abort: (conversationId: string) => Promise<void>
    onStream: (cb: (event: GroupStreamEvent) => void) => () => void
  }
  chat: {
    listMessages: (conversationId: string) => Promise<Message[]>
    send: (input: SendChatInput) => Promise<SendChatResult>
    abort: (streamId: string) => Promise<void>
    /** 回答 AI 的提问,工具循环收到后继续往下跑 */
    answerQuestion: (questionId: string, answer: AskUserAnswer) => Promise<void>
    /** 订阅流式事件,返回取消订阅函数。整个应用只应有一个订阅者(chat store) */
    onStream: (cb: (event: ChatStreamEvent) => void) => () => void
  }
  preview: {
    /** 预览 iframe 里出的运行时错误,上报给主进程,下一轮带给模型 */
    reportError: (projectId: string, artifactId: string, message: string) => Promise<void>
  }
  workspace: {
    list: (scope: RootScope) => Promise<WorkspaceRoot[]>
    /** 弹目录选择框授权一个本地目录;用户取消返回 null */
    grant: (scope: RootScope) => Promise<WorkspaceRoot | null>
    /** 弹原生文件选择框并授权选中的文件 */
    pickFiles: (scope: RootScope) => Promise<GrantOutcome>
    /** 授权一批已知路径(从拖拽拿到的) */
    grantPaths: (scope: RootScope, paths: string[]) => Promise<GrantOutcome>
    /**
     * 拖进来的 File → 真实磁盘路径。
     *
     * Electron 32 起 File.path 被移除,只能走 preload 里的 webUtils,
     * 渲染进程自己拿不到——这是拖拽文件唯一的取路径手段。
     */
    pathOf: (file: File) => string
    revoke: (id: string) => Promise<void>
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
    /** 导入图片字节(拖拽 / 粘贴 / 选文件通用),入库前会按需缩放 */
    importImage: (input: ImportImageInput) => Promise<AssetRef>
  }
  sync: {
    getConfig: () => Promise<DataBackendView>
    setConfig: (input: DataBackendInput) => Promise<DataBackendView>
  }
  /** MCP 服务。事实来源是 ~/.antd-designer/mcp.json,身份即名字 */
  mcp: {
    list: () => Promise<{ servers: McpServerView[]; problem?: string }>
    /** 新增或整体覆盖一条(改名 = 删旧加新) */
    upsert: (name: string, input: McpServerInput) => Promise<McpServerView>
    setEnabled: (name: string, enabled: boolean) => Promise<void>
    remove: (name: string) => Promise<void>
    /** 粘贴 mcpServers JSON(Claude Desktop / Cursor / VS Code 方言都认),合并进 mcp.json */
    importJson: (json: string) => Promise<McpServerView[]>
  }
  /**
   * 「我的技能」的文件管理,全部 scoped 在 ~/.antd-designer/skills 下。
   * 技能的身份是目录名;编辑走左树右编辑器,直接读写文件。
   */
  skill: {
    /** 新建技能:建目录 + 模板 SKILL.md */
    create: (name: string) => Promise<InstalledSkill>
    /** 从市场安装:写 SKILL.md 到我的技能目录 */
    installMarket: (id: string) => Promise<InstalledSkill>
    /** 删除整个技能目录 */
    remove: (name: string) => Promise<void>
    /** 弹文件框导入技能压缩包(必须包含 SKILL.md),解压到我的技能目录;取消返回 null */
    importPackage: () => Promise<InstalledSkill | null>
    /** 技能内的文件树 */
    tree: (name: string) => Promise<SkillFileNode[]>
    readFile: (name: string, path: string) => Promise<string>
    writeFile: (name: string, path: string, content: string) => Promise<void>
    mkdir: (name: string, path: string) => Promise<void>
    /** 删除技能内的文件或目录 */
    removeEntry: (name: string, path: string) => Promise<void>
  }
}
