import { sql } from 'drizzle-orm'
import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'
import { ulid } from 'ulid'
import type { ProjectSettings } from '../../shared/types'

/**
 * 表结构的唯一事实来源。
 *
 * 列名写 snake_case、属性名用 camelCase，映射在这里声明一次，
 * 不用再手写 Row 接口和转换函数。改完这里跑 `pnpm db:generate`
 * 生成迁移 SQL。
 *
 * 两条全局约定（为将来的多设备同步打的地基，现在改代价最小）：
 * 1. 所有参与同步的业务表一律用 text ULID 主键——自增 int 在多设备
 *    各自插入时必然撞号，届时无法合并；ULID 时间有序，索引效率
 *    与自增相差无几。
 * 2. 每张业务表都有 updated_at（ISO 文本，字典序即时间序），
 *    同步引擎做 last-write-wins 冲突比较全靠它。
 */

const id = (): ReturnType<typeof text> =>
  text('id')
    .primaryKey()
    .$defaultFn(() => ulid())

const timestamps = {
  createdAt: text('created_at')
    .notNull()
    .default(sql`(datetime('now'))`),
  updatedAt: text('updated_at')
    .notNull()
    .default(sql`(datetime('now'))`)
}

export const projects = sqliteTable(
  'projects',
  {
    id: id(),
    name: text('name').notNull(),
    // 产物技术栈与设计模式在创建时定死——切换意味着整棵文件树推倒重来，
    // 不如引导用户新建项目
    stack: text('stack').notNull().default('html'),
    designMode: text('design_mode').notNull().default('design'),
    description: text('description').notNull().default(''),
    /**
     * 工作台的"上次选了什么":模型、技能、MCP。
     *
     * 用 JSON 而不是拆成列,是因为这一类"记住上次的选择"注定会继续加
     * (已经从模型长到技能和 MCP),每加一样都开一次迁移不划算;而它永远
     * 只按 project id 整取整存,没有查询需求,拆列换不来任何好处。
     */
    settings: text('settings', { mode: 'json' }).$type<ProjectSettings>(),
    ...timestamps
  },
  (table) => [index('idx_projects_updated_at').on(table.updatedAt)]
)

/**
 * AI 供应商。内置预设（openai/anthropic/google/deepseek/zhipu）不写在
 * 迁移里，而是启动时按 slug 幂等补种（见 repo/provider.ts）——迁移一经
 * 发布不可修改，预设的默认 baseUrl、新增预设却会随版本演进。
 */
export const providers = sqliteTable('providers', {
  id: id(),
  slug: text('slug').notNull().unique(),
  name: text('name').notNull(),
  // 决定用哪个 AI SDK 工厂：openai | anthropic | google | deepseek | openai-compatible
  // 智谱和所有自定义供应商都走 openai-compatible + baseUrl
  adapter: text('adapter').notNull(),
  baseUrl: text('base_url'),
  // safeStorage 加密后的 base64；keyStorage='plain' 表示该系统没有可用的
  // 安全存储（如无 keyring 的 Linux），密钥被迫明文保存并在 UI 上警告
  apiKeyCipher: text('api_key_cipher'),
  keyStorage: text('key_storage').notNull().default('safe'),
  // 录入时截下的 `sk-…abcd` 提示。读接口只回这个，密文永不出主进程
  keyHint: text('key_hint'),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  isBuiltin: integer('is_builtin', { mode: 'boolean' }).notNull().default(false),
  ...timestamps
})

export const models = sqliteTable(
  'models',
  {
    id: id(),
    providerId: text('provider_id')
      .notNull()
      .references(() => providers.id, { onDelete: 'cascade' }),
    // 传给 API 的真实模型名，如 claude-sonnet-4-5
    modelId: text('model_id').notNull(),
    displayName: text('display_name').notNull(),
    // 模型类型(单值):chat | image | embedding | rerank | tts | stt。
    // 决定它出现在哪个功能里(对话选择器 / 绘图 / 检索…)
    type: text('type').notNull().default('chat'),
    // 能力 JSON 数组,仅对 chat 类型有意义:["vision","files","tools"]
    // (识图 / 文件识别 / 工具调用)。列名历史原因叫 capabilities
    capabilities: text('capabilities').notNull().default('[]'),
    // 上下文窗口（token）。组装对话上下文时的预算依据，宁可保守
    contextWindow: integer('context_window').notNull().default(64000),
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
    isBuiltin: integer('is_builtin', { mode: 'boolean' }).notNull().default(false),
    sortOrder: integer('sort_order').notNull().default(0),
    ...timestamps
  },
  (table) => [uniqueIndex('uniq_models_provider_model').on(table.providerId, table.modelId)]
)

export const conversations = sqliteTable(
  'conversations',
  {
    id: id(),
    /**
     * 设计会话挂在项目下；纯聊天没有项目，这里为 NULL。
     *
     * 聊天不是"没有产物的项目"——它没有版本、没有文件树、没有导出。
     * 硬塞一个哨兵项目会让项目列表、导出、同步每一处都要记得把它过滤掉，
     * 漏一处就漏出来了。可空更诚实。
     */
    projectId: text('project_id').references(() => projects.id, { onDelete: 'cascade' }),
    title: text('title').notNull().default(''),
    /** 'design' 项目里的设计会话 | 'chat' 独立的纯聊天 */
    kind: text('kind').notNull().default('design'),
    ...timestamps
  },
  (table) => [
    index('idx_conversations_project').on(table.projectId),
    // 聊天列表按 kind 过滤 + 按时间倒序，这两列一起建索引
    index('idx_conversations_kind').on(table.kind, table.updatedAt)
  ]
)

export const messages = sqliteTable(
  'messages',
  {
    id: id(),
    conversationId: text('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    role: text('role').notNull(),
    // 结构化内容 JSON：[{type:'text',text}, {type:'file',path,action}]。
    // assistant 产出的文件正文不存这里（在 artifact_files），parts 只留引用——
    // 既不存两份大文本，回放历史时也天然不带旧文件体
    parts: text('parts').notNull().default('[]'),
    status: text('status').notNull().default('complete'),
    // {inputTokens, outputTokens}，上下文预算校准和用量统计用
    usage: text('usage'),
    // 供应商/模型快照：供应商被删后历史消息仍能显示当时用的什么
    providerSlug: text('provider_slug'),
    modelId: text('model_id'),
    // 该条 assistant 消息产出的设计稿版本
    artifactId: text('artifact_id'),
    ...timestamps
  },
  (table) => [index('idx_messages_conversation').on(table.conversationId)]
)

export const artifacts = sqliteTable(
  'artifacts',
  {
    id: id(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    messageId: text('message_id'),
    // 项目内递增的版本号，给 UI 的版本下拉用
    version: integer('version').notNull(),
    // 增量修改的父版本；据此把父版未变的文件复制进新版本
    baseArtifactId: text('base_artifact_id'),
    summary: text('summary').notNull().default(''),
    ...timestamps
  },
  (table) => [index('idx_artifacts_project').on(table.projectId)]
)

/**
 * 每个版本存完整文件树（增量修改时复制父版未变行）。设计稿单文件
 * 几 KB～几十 KB，全量拷贝换来"版本切换 = 一次查询、无需回放 delta
 * 链"。若将来体积失控，再演进为内容寻址 blobs 去重。
 */
export const artifactFiles = sqliteTable(
  'artifact_files',
  {
    id: id(),
    artifactId: text('artifact_id')
      .notNull()
      .references(() => artifacts.id, { onDelete: 'cascade' }),
    path: text('path').notNull(),
    content: text('content').notNull(),
    ...timestamps
  },
  (table) => [uniqueIndex('uniq_artifact_files_path').on(table.artifactId, table.path)]
)

/**
 * MCP 服务配置。transport 决定连接方式:stdio 本地起进程(command/args/env),
 * sse|http 连远程端点(url/headers)。args/env/headers 都是 JSON 文本。
 * 只存配置;连接与工具发现在对话链路接入时实现。
 */
export const mcpServers = sqliteTable('mcp_servers', {
  id: id(),
  name: text('name').notNull(),
  transport: text('transport').notNull().default('stdio'),
  command: text('command'),
  args: text('args').notNull().default('[]'),
  env: text('env').notNull().default('{}'),
  url: text('url'),
  headers: text('headers').notNull().default('{}'),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  ...timestamps
})

/** 技能:可复用的提示词包,启用后注入设计对话的 system prompt。 */
export const skills = sqliteTable('skills', {
  id: id(),
  name: text('name').notNull(),
  description: text('description').notNull().default(''),
  content: text('content').notNull(),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  ...timestamps
})

/**
 * 二进制资源索引（图片等）。实体不进库：backend='local' 时 location 是
 * assets 目录下的相对路径，'s3' 时是对象 key。渲染进程只见 asset://<id>。
 */
export const assets = sqliteTable('assets', {
  id: id(),
  mime: text('mime').notNull(),
  size: integer('size').notNull(),
  sha256: text('sha256').notNull(),
  backend: text('backend').notNull().default('local'),
  location: text('location').notNull(),
  ...timestamps
})

/**
 * 同步基础设施（本期只埋点，引擎二期做）。change_log 由 SQLite 触发器
 * 写入（见 db/index.ts 的 ensureSyncTriggers），不侵入 repo 层，
 * 所有写路径都逃不过触发器，零遗漏。
 */
export const changeLog = sqliteTable('change_log', {
  seq: integer('seq').primaryKey({ autoIncrement: true }),
  tbl: text('tbl').notNull(),
  rowId: text('row_id').notNull(),
  // 'upsert' | 'delete'——同步只需要知道"这行要不要重推"，不需要细粒度 diff
  op: text('op').notNull(),
  changedAt: text('changed_at')
    .notNull()
    .default(sql`(datetime('now'))`)
})

/** 本机同步元信息：device_id / push、pull 游标 / sync_applying 防回环标志 */
export const localMeta = sqliteTable('local_meta', {
  k: text('k').primaryKey(),
  v: text('v').notNull()
})

export type ProjectRow = typeof projects.$inferSelect
export type ProviderRow = typeof providers.$inferSelect
export type ModelRow = typeof models.$inferSelect
export type ConversationRow = typeof conversations.$inferSelect
export type MessageRow = typeof messages.$inferSelect
export type ArtifactRow = typeof artifacts.$inferSelect
export type ArtifactFileRow = typeof artifactFiles.$inferSelect
export type AssetRow = typeof assets.$inferSelect
export type McpServerRow = typeof mcpServers.$inferSelect
export type SkillRow = typeof skills.$inferSelect

/**
 * 用户授权给某个项目的本地目录。
 *
 * 本地文件工具的**唯一权限来源**:用户主动选一个目录才产生一行,工具只
 * 能在这些目录的子树里活动。没有这张表里的记录,读本地文件的工具连注册
 * 都不注册——AI 拿不到一个可以试探的入口。
 */
/**
 * 授权范围。两种归属**恰好有一个非空**:
 *
 * - projectId:设计项目的授权,跟着项目走
 * - conversationId:纯聊天的授权,跟着这次会话走,会话删了就回收
 *
 * 不做成一个通用的 ownerId:那样就没有外键级联了,删项目/删会话时要靠
 * 应用代码记得清理,迟早漏。两个各自带级联的可空外键更省心。
 */
export const workspaceRoots = sqliteTable('workspace_roots', {
  id: id(),
  projectId: text('project_id').references(() => projects.id, { onDelete: 'cascade' }),
  conversationId: text('conversation_id').references(() => conversations.id, {
    onDelete: 'cascade'
  }),
  /** 绝对路径,已 realpath 解析过 */
  path: text('path').notNull(),
  /** 显示名,默认取目录名 */
  name: text('name').notNull(),
  ...timestamps
})

export type WorkspaceRootRow = typeof workspaceRoots.$inferSelect
