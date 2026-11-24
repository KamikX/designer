import { sql } from 'drizzle-orm'
import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'
import { ulid } from 'ulid'
import type {
  DesignTarget,
  ExternalLibraryRef,
  PreviewLib,
  SessionSettings,
  VisualStylePriority
} from '../../shared/types'

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
    /**
     * 勾选的端类型(mobile/web/landing/admin),JSON 数组。
     * null 表示没选过——老项目和跳过勾选的都落在这里,提示词层不注入端契约。
     */
    targets: text('targets', { mode: 'json' }).$type<DesignTarget[]>(),
    /** 勾选的组件库(antdv-next 等),JSON 数组。null = 纯 Tailwind */
    libs: text('libs', { mode: 'json' }).$type<PreviewLib[]>(),
    externalLibraries: text('external_libraries', { mode: 'json' }).$type<ExternalLibraryRef[]>(),
    description: text('description').notNull().default(''),
    codeInstructions: text('code_instructions').notNull().default(''),
    /** 项目的视觉方向；空字符串表示用户尚未定义 */
    styleBrief: text('style_brief').notNull().default(''),
    designDocument: text('design_document').notNull().default(''),
    visualStylePriority: text('visual_style_priority')
      .$type<VisualStylePriority>()
      .notNull()
      .default('styleBrief'),
    /**
     * 工作台的"上次选了什么":模型、技能、MCP。
     *
     * 用 JSON 而不是拆成列,是因为这一类"记住上次的选择"注定会继续加
     * (已经从模型长到技能和 MCP),每加一样都开一次迁移不划算;而它永远
     * 只按 project id 整取整存,没有查询需求,拆列换不来任何好处。
     */
    settings: text('settings', { mode: 'json' }).$type<SessionSettings>(),
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
    /**
     * 这条会话"上次选了什么"。纯聊天靠它记住模型 / 技能 / MCP / 联网开关。
     *
     * 和 projects.settings 是同一个形状:设计会话的选择跟着项目走,聊天没有
     * 项目,只能跟着会话。存 JSON 的理由也一样——这类字段注定还会加。
     */
    settings: text('settings', { mode: 'json' }).$type<SessionSettings>(),
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
    /**
     * 群组会话里的发言者(角色 id,如 'pm' / 'ui';用户消息为 'user')。
     * 普通对话为 NULL——role 列只分 user/assistant,群里要知道是哪个 agent 说的。
     */
    author: text('author'),
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
 * 群组会话的「前情纪要」:transcript 超预算折叠旧发言时,用它替代机械存根
 * (见 ai/group-transcript.ts / ai/group-digest.ts)。
 *
 * 纯派生缓存——随时可以从 messages 重新生成,所以不进 SYNCED_TABLES,
 * 也不需要 ULID 主键(一个会话恒只有一行,删会话级联删)。
 */
export const groupDigests = sqliteTable('group_digests', {
  conversationId: text('conversation_id')
    .primaryKey()
    .references(() => conversations.id, { onDelete: 'cascade' }),
  text: text('text').notNull(),
  // 纪要已覆盖到这条消息(含);增量更新只喂这之后的新发言
  coveredUntilId: text('covered_until_id').notNull(),
  ...timestamps
})

// mcp_servers 与 skills 两张表已退役:MCP 收敛到 ~/.antd-designer/mcp.json,
// 技能收敛到 ~/.antd-designer/skills 文件目录。双事实来源(DB + 文件)并存了
// 一段时间,市场装进 DB、AI 装进文件、两边互相看不见——按约定直接删表不迁移。

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
/* ------------------------------------------------------------------ */
/* AI 可观测性(本机数据,不同步)                                        */
/*                                                                      */
/* 五张表分两类:                                                        */
/* - 诊断明细(ai_runs / ai_run_steps / tool_runs)+ 去重桥表             */
/*   (model_usage_run_days)只保留 7 天;                                */
/* - 日聚合(model_usage_daily)长期保留,用户可单独清除。                 */
/*                                                                      */
/* 长期聚合表不建业务外键:provider / project 删除后用量必须还在,        */
/* 靠非空规范化维度键(provider_key / project_key)保证唯一 upsert        */
/* 可靠——SQLite 里多个 NULL 互不冲突,可空列做不了唯一维度。             */
/* 任何表都不许出现 prompt、reasoning、文件正文或补丁正文。              */
/* ------------------------------------------------------------------ */

export const aiRuns = sqliteTable(
  'ai_runs',
  {
    id: id(),
    /** 关联消息/会话只存快照 id,不建外键——消息删了诊断照样能看 7 天 */
    messageId: text('message_id'),
    conversationId: text('conversation_id'),
    /** 项目删除时诊断跟着走,这是诊断三表唯一的业务级联入口 */
    projectId: text('project_id').references(() => projects.id, { onDelete: 'cascade' }),
    providerId: text('provider_id'),
    providerSlug: text('provider_slug').notNull().default(''),
    modelId: text('model_id').notNull().default(''),
    /** design | chat | group | assistant | document_summary | provider_test */
    scene: text('scene').notNull(),
    /** running | complete | error | aborted | interrupted */
    status: text('status').notNull().default('running'),
    startedAt: text('started_at').notNull(),
    endedAt: text('ended_at'),
    firstOutputAt: text('first_output_at'),
    firstFileChangeAt: text('first_file_change_at'),
    modelCallCount: integer('model_call_count').notNull().default(0),
    toolCallCount: integer('tool_call_count').notNull().default(0),
    toolFailureCount: integer('tool_failure_count').notNull().default(0),
    /** 累计 token;null = 从未有 step 上报过对应字段 */
    inputTokens: integer('input_tokens'),
    outputTokens: integer('output_tokens'),
    sdkTotalTokens: integer('sdk_total_tokens'),
    toolBreaker: integer('tool_breaker', { mode: 'boolean' }).notNull().default(false),
    tokenBreaker: integer('token_breaker', { mode: 'boolean' }).notNull().default(false),
    errorBreaker: integer('error_breaker', { mode: 'boolean' }).notNull().default(false),
    ...timestamps
  },
  (table) => [
    index('idx_ai_runs_message').on(table.messageId),
    index('idx_ai_runs_started').on(table.startedAt),
    index('idx_ai_runs_project').on(table.projectId)
  ]
)

export const aiRunSteps = sqliteTable(
  'ai_run_steps',
  {
    id: id(),
    runId: text('run_id')
      .notNull()
      .references(() => aiRuns.id, { onDelete: 'cascade' }),
    /** AI SDK 的 callId,与 run_id 一起构成幂等收尾的键 */
    callId: text('call_id').notNull(),
    stepNumber: integer('step_number').notNull().default(0),
    providerId: text('provider_id'),
    providerSlug: text('provider_slug').notNull().default(''),
    modelId: text('model_id').notNull().default(''),
    startedAt: text('started_at').notNull(),
    firstOutputAt: text('first_output_at'),
    endedAt: text('ended_at'),
    stepTimeMs: integer('step_time_ms'),
    responseTimeMs: integer('response_time_ms'),
    timeToFirstOutputMs: integer('time_to_first_output_ms'),
    /** pending | complete | error | aborted。请求发出即插入,抛错也不消失 */
    status: text('status').notNull().default('pending'),
    /**
     * 用量附加状态机:pending → ended_without_usage → aggregated。
     * onLanguageModelCallEnd 与 onStepEnd 哪个先到都行,聚合恰好发生一次。
     */
    usageState: text('usage_state').notNull().default('pending'),
    inputTokens: integer('input_tokens'),
    inputNoCacheTokens: integer('input_no_cache_tokens'),
    cacheReadTokens: integer('cache_read_tokens'),
    cacheWriteTokens: integer('cache_write_tokens'),
    outputTokens: integer('output_tokens'),
    outputTextTokens: integer('output_text_tokens'),
    reasoningTokens: integer('reasoning_tokens'),
    sdkTotalTokens: integer('sdk_total_tokens'),
    providerTotalTokens: integer('provider_total_tokens'),
    /** UsageReportedFields JSON,区分明确 0 与未上报 */
    usageReported: text('usage_reported'),
    finishReason: text('finish_reason'),
    httpStatus: integer('http_status'),
    /** 已映射的脱敏错误码,不是原始 error message */
    errorCode: text('error_code'),
    ...timestamps
  },
  (table) => [
    uniqueIndex('uniq_ai_run_steps_call').on(table.runId, table.callId),
    index('idx_ai_run_steps_run').on(table.runId)
  ]
)

export const toolRuns = sqliteTable(
  'tool_runs',
  {
    id: id(),
    runId: text('run_id')
      .notNull()
      .references(() => aiRuns.id, { onDelete: 'cascade' }),
    callId: text('call_id').notNull(),
    stepNumber: integer('step_number').notNull().default(0),
    toolName: text('tool_name').notNull(),
    inputStartedAt: text('input_started_at'),
    inputCompletedAt: text('input_completed_at'),
    execStartedAt: text('exec_started_at'),
    execCompletedAt: text('exec_completed_at'),
    inputChars: integer('input_chars'),
    outputChars: integer('output_chars'),
    affectedFileCount: integer('affected_file_count'),
    /** 经 ToolTraceSanitizer 白名单产出的脱敏目标,绝不放原始入参 */
    targetSummary: text('target_summary'),
    /** running | success | recoverable_error | fatal_error | aborted */
    status: text('status').notNull().default('running'),
    errorCode: text('error_code'),
    /** 二次脱敏后的摘要,上限 240 字符 */
    errorSummary: text('error_summary'),
    recovered: integer('recovered', { mode: 'boolean' }).notNull().default(false),
    breakerTripped: integer('breaker_tripped', { mode: 'boolean' }).notNull().default(false),
    ...timestamps
  },
  (table) => [
    uniqueIndex('uniq_tool_runs_call').on(table.runId, table.callId),
    index('idx_tool_runs_run').on(table.runId)
  ]
)

export const modelUsageDaily = sqliteTable(
  'model_usage_daily',
  {
    id: id(),
    /** UTC 日期(YYYY-MM-DD),按 step 实际发生日归属 */
    date: text('date').notNull(),
    /** 非空规范化维度键:provider ID,内部调用用稳定场景键 */
    providerKey: text('provider_key').notNull(),
    providerId: text('provider_id'),
    providerSlug: text('provider_slug').notNull().default(''),
    modelId: text('model_id').notNull(),
    scene: text('scene').notNull(),
    /** `project:<id>` 或 'none' */
    projectKey: text('project_key').notNull(),
    projectId: text('project_id'),
    stepCount: integer('step_count').notNull().default(0),
    runCount: integer('run_count').notNull().default(0),
    /** 和数默认 0;是否有意义看对应 reported_calls——0/0 即"未报告" */
    inputTokens: integer('input_tokens').notNull().default(0),
    inputNoCacheTokens: integer('input_no_cache_tokens').notNull().default(0),
    cacheReadTokens: integer('cache_read_tokens').notNull().default(0),
    cacheWriteTokens: integer('cache_write_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    outputTextTokens: integer('output_text_tokens').notNull().default(0),
    reasoningTokens: integer('reasoning_tokens').notNull().default(0),
    sdkTotalTokens: integer('sdk_total_tokens').notNull().default(0),
    providerTotalTokens: integer('provider_total_tokens').notNull().default(0),
    reportedInputCalls: integer('reported_input_calls').notNull().default(0),
    reportedNoCacheCalls: integer('reported_no_cache_calls').notNull().default(0),
    reportedCacheReadCalls: integer('reported_cache_read_calls').notNull().default(0),
    reportedCacheWriteCalls: integer('reported_cache_write_calls').notNull().default(0),
    reportedOutputCalls: integer('reported_output_calls').notNull().default(0),
    reportedTextCalls: integer('reported_text_calls').notNull().default(0),
    reportedReasoningCalls: integer('reported_reasoning_calls').notNull().default(0),
    reportedSdkTotalCalls: integer('reported_sdk_total_calls').notNull().default(0),
    reportedProviderTotalCalls: integer('reported_provider_total_calls').notNull().default(0),
    ...timestamps
  },
  (table) => [
    uniqueIndex('uniq_model_usage_daily_dim').on(
      table.date,
      table.providerKey,
      table.modelId,
      table.scene,
      table.projectKey
    )
  ]
)

/**
 * 日聚合的 run 去重桥表:INSERT OR IGNORE 成功才给当日维度 run_count +1。
 * 只保留 7 天——窗口过后不可能再收到该 run 的回调,删除不影响已聚合数据。
 */
export const modelUsageRunDays = sqliteTable(
  'model_usage_run_days',
  {
    id: id(),
    runId: text('run_id').notNull(),
    date: text('date').notNull(),
    providerKey: text('provider_key').notNull(),
    modelId: text('model_id').notNull(),
    scene: text('scene').notNull(),
    projectKey: text('project_key').notNull(),
    ...timestamps
  },
  (table) => [
    uniqueIndex('uniq_model_usage_run_days_dim').on(
      table.runId,
      table.date,
      table.providerKey,
      table.modelId,
      table.scene,
      table.projectKey
    ),
    index('idx_model_usage_run_days_date').on(table.date)
  ]
)

export type AiRunRow = typeof aiRuns.$inferSelect
export type AiRunStepRow = typeof aiRunSteps.$inferSelect
export type ToolRunRow = typeof toolRuns.$inferSelect
export type ModelUsageDailyRow = typeof modelUsageDaily.$inferSelect

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
