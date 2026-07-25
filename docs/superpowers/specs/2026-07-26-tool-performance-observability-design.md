# AI 工具性能、可靠编辑与用量治理设计

## 背景

Designer 的 tools 模式把文件正文保存在主进程 `SessionVfs`，模型通过
`read_file`、`edit_file`、`apply_patch` 等工具逐步修改设计稿。对 SQLite 中
“Antdv Next测试”项目的只读分析显示，用户感知到的“应用补丁很慢”并不是
SQLite 或本地补丁算法慢，而是以下问题叠加：

- UI 在 `tool-input-start` 就显示“应用补丁”，把模型生成完整补丁参数的时间误算成
  本地执行时间；
- 每个工具 step 会再次提交累积的工具调用、工具结果和上下文，实际轮次累计输入达到
  45 万～68 万 token；
- `read_file` 和 `search_files` 会截断超过 800 字符的单行，但编辑工具要求旧文本
  逐字符匹配，导致超长 Vue 数组、columns 和 options 容易补丁失败；
- `apply_patch` 是跨文件原子事务，一个 hunk 失败会回滚整批，模型随后重新读取和重试；
- 工具活动只活在渲染进程内存里，完成后没有足够的持久数据还原具体错误和阶段耗时。

本设计在保留现有 VFS、artifact 和 AI SDK 工具循环的前提下，增加可观测性、长期模型
用量、基于 MagicString 的可靠编辑和 step 级上下文治理。

## 目标

1. 区分模型等待、工具参数生成、本地执行、结果返回和下一步决策耗时。
2. 工具诊断明细保留 7 天；模型用量按 provider/model 长期聚合。
3. 准确统计输入、非缓存输入、缓存读取、缓存写入、文本输出和 reasoning token。
4. 用服务端持有的字符区间和 MagicString 消除模型复述旧文本造成的匹配失败。
5. 压缩已经完成或已经失效的大体积工具历史，避免每个 step 重发补丁和文件正文。
6. 对重复失败、重复工具调用和失控的累计 token 建立程序化熔断。
7. 保持旧消息、旧 artifact、markers 协议和现有文件工具兼容。

## 非目标

- 不把模型 prompt、reasoning、文件正文或补丁正文写进诊断表。
- 不建设通用 APM、云端日志服务或跨设备用量合并。
- 不为 Vue、TypeScript、CSS 分别引入 AST 编辑器。
- 不删除现有 `edit_file`、`multi_edit_file` 或 `apply_patch`。
- 不在本期实现模型价格表和金额结算；本期只保证 token 统计准确。
- 不生成 sourcemap。MagicString 只作为保留格式的字符串编辑引擎。

## 验收指标

以 7 个 Vue/CSS 文件、约 25KB、同时修改 5 个文件并包含 800～1700 字符超长行的
RBAC 场景作为固定基准：

- 本地批量编辑 p95 小于 100ms；
- 普通修改首个文件变化尽量在 15 秒内出现；
- 单轮工具调用目标不超过 20 次，硬上限 40 次；
- 64K 模型累计输入目标小于 200K，硬上限约 320K；
- 编辑失败率低于 5%，同一错误不得连续发生两次；
- 不发生由截断旧文本导致的 `MATCH_NOT_FOUND`；
- 每次错误均可查询工具、阶段、错误码、耗时和脱敏目标；
- 7 天诊断清理不影响消息、artifact 或长期模型用量。

## 总体架构

```text
Renderer UI
    │
    ▼
Chat Orchestrator ──► RunContextLedger / Context Governor
    │                            │
    ▼                            ▼
AI SDK streamText ◄──────── prepareStep
    │
    ├── 生命周期事件 ──► RunTraceCollector ──► SQLite 诊断与用量
    │
    ▼
File Tools ──► AnchorRegistry ──► MagicString Batch Editor ──► SessionVfs
                                                             │
                                                             ▼
                                                      Monaco / artifact
```

组件职责：

- `RunTraceCollector`：采集 run、step、tool 的阶段耗时和脱敏元数据。
- `UsageAggregator`：按 step 聚合模型用量，独立于整轮是否成功。
- `RunContextLedger`：维护文件 revision、anchor、技能激活、工具失败和累计预算。
- `ContextGovernor`：在 `prepareStep` 中压缩工具历史、路由端模板和实施预算。
- `AnchorRegistry`：把搜索结果或任意文件范围绑定到当前 VFS revision。
- `MagicStringBatchEditor`：校验区间后执行同文件多操作和跨文件原子提交。

这些单元通过明确的数据结构通信，不让遥测、上下文压缩或 MagicString 逻辑继续膨胀
`chat-service.ts`。

## 追踪数据模型

### `ai_runs`

每次语言模型 run 对应一行。`message_id`、`conversation_id` 和 `project_id` 都允许为空：
设计/聊天/群组 run 关联消息，后台摘要、内置助手和 provider 连通性测试没有消息也必须计量。
所有语言模型入口统一经一个 tracer 包装，调用场景枚举为
`design | chat | group | assistant | document_summary | provider_test`。provider 连通性测试
是真实计费请求，计入长期用量，但用量页可按场景排除。

- `id`
- `message_id`，可空
- `conversation_id`，可空
- `project_id`，可空
- provider ID、provider slug 快照、model ID
- 调用场景：
  `design | chat | group | assistant | document_summary | provider_test`
- `status`：`running | complete | error | aborted | interrupted`
- 开始、结束、首个输出、首个文件变化时间
- 总模型调用次数、工具调用次数、工具失败次数
- 累计 token 汇总
- 是否触发工具、token 或错误熔断

应用启动时把遗留的 `running` 更新为 `interrupted`。

### `ai_run_steps`

每次实际模型请求一行：

- `run_id`、AI SDK `call_id`、`step_number`
- provider/model 快照
- 开始、首包、结束时间
- `stepTimeMs`、`responseTimeMs`、`timeToFirstOutputMs`
- 输入、非缓存输入、缓存读、缓存写、输出、文本输出、reasoning、total token
- provider 是否报告每个可选字段
- finish reason、HTTP 状态或脱敏错误码

### `tool_runs`

每次工具调用一行：

- `run_id`、`call_id`、`step_number`、`tool_name`
- 参数开始/完成时间
- 本地执行开始/完成时间
- 参数字符数、结果字符数、影响文件数量
- 脱敏目标摘要
- `status`：`success | recoverable_error | fatal_error | aborted`
- 结构化错误码、不超过 240 字符的脱敏摘要
- 是否触发恢复或熔断

不保存完整输入、完整输出、补丁、文件内容、搜索词或 reasoning。

### `model_usage_daily`

长期保留的日聚合表，维度为：

- 日期
- provider ID 与 slug 快照
- model ID
- 调用场景
- project ID，可空

指标为：

- 调用 step 数和 run 数
- `input_tokens`
- `input_no_cache_tokens`
- `cache_read_tokens`
- `cache_write_tokens`
- `output_tokens`
- `output_text_tokens`
- `reasoning_tokens`
- AI SDK 归一化的 `sdk_total_tokens`
- 适配器白名单提取的 `provider_total_tokens`
- 每个可选字段的 `reported_calls`

`reported_calls` 用于区分明确为 0、完全未报告和部分报告。不能用 0 填充 provider 未返回的
缓存字段。

### `model_usage_run_days`

这是长期聚合的短期去重桥表，主键为：

```text
run_id + UTC date + provider_key + model_id + scene + project_key
```

每个 step 的 token 归它实际发生的 UTC 日期。事务先 `INSERT OR IGNORE` 当日 run 维度；
只有插入成功时才给同维度 `model_usage_daily.run_count` 加一。因此跨午夜 run 会在两个日期
各计一次“当日活跃 run”，两个日期的平均每轮 token 都有分子和分母；同一天的多个 step
仍只算一个 run。桥表跟诊断明细一样保留 7 天，超过窗口后不可能再收到该 run 的回调，
删除不会影响已经聚合的日数据。

SQLite 的可空列不能直接参与可靠的唯一 upsert，因为多个 `NULL` 不冲突。聚合表因此使用
非空规范化维度键：

- `provider_key`：调用时的 provider ID；没有持久 provider 的内部调用使用稳定场景键；
- `project_key`：`project:<id>` 或固定字符串 `none`；
- 唯一键：`date + provider_key + model_id + scene + project_key`。

provider/project 的显示 ID 和名称另存快照，不对业务表建外键。provider 或 project 删除后，
长期用量仍保留并显示为“已删除的 provider/项目”，不会因 `SET NULL` 改变唯一维度或产生
重复行。诊断明细可以关联 message/project 并按业务删除策略级联；长期聚合绝不级联。

### 留存与同步

- `ai_runs`、`ai_run_steps`、`tool_runs`、`model_usage_run_days` 只保留 7 天。
- `model_usage_daily` 长期保留，用户可单独清除。
- 诊断清理每日启动后执行一次，每轮结束后可异步触发一次幂等清理。
- 五张表都是本机数据，不进入 `change_log`，不参与项目同步或 artifact 导出。
- 删除项目时诊断明细级联删除；长期用量没有业务外键，保留调用时的 project/provider
  快照和规范化维度键。

### 隐私

追踪不能从任意工具输入中自动挑字段或序列化对象，必须经过按工具名注册的
`ToolTraceSanitizer` 白名单：

- 设计稿文件工具：只保存通过 VFS `assertPath` 的设计稿相对路径、操作/文件数量和字符数；
- 本地 workspace 工具：路径只保存不可逆哈希和扩展名，不保存绝对路径、workspace 相对
  路径或 basename；
- Web/Browser：URL 只保存 host，查询只保存长度和结果数；
- skill：允许保存技能名；
- ask_user：只保存题目/选项数量，不保存题目、选项和回答；
- MCP：默认只保存 server/tool 名、输入/输出字符数，不保存任何字段值；
- 未注册工具：只保存工具名、大小、耗时和固定错误码，没有目标摘要。

不能依赖“高熵检测”识别密钥，因为低熵口令同样敏感。provider 和未知工具的原始 error
message/body 不落库；只保存 HTTP 状态、已知错误映射或固定的“工具执行失败”。所有可保存的
错误摘要再经过路径、URL、email 和常见凭证形态脱敏，作为第二道防线。

## 用量采集

AI SDK 7 的 `StepResult.usage` 已提供：

```ts
inputTokens
inputTokenDetails.noCacheTokens
inputTokenDetails.cacheReadTokens
inputTokenDetails.cacheWriteTokens
outputTokens
outputTokenDetails.textTokens
outputTokenDetails.reasoningTokens
totalTokens
```

每个 `onStepEnd` 都在一个 SQLite 事务中：

1. 插入 `ai_run_steps`；
2. upsert 当日 `model_usage_daily`；
3. 更新 `ai_runs` 汇总。

事务用 `model_usage_run_days` 的复合主键去重；只有 `INSERT OR IGNORE` 实际插入一行时才给
当日、当 provider/model/scene/project 维度的 `run_count` 加一。后续同维度 step 只增加
`step_count` 和 token。run 跨 UTC 日期或极少数情况下在同一 run 切换模型时，各自维度都有
对应的当日 run 分母。

不能只用整轮 `result.usage`，否则中途失败的多 step 调用可能漏记，也无法按 step 查看缓存
命中和性能。provider 未报告的字段保持 `null`，同时不增加对应 `reported_calls`。

`usage.totalTokens` 保存为 `sdk_total_tokens`。如果 `usage.raw` 中存在适配器明确白名单映射的
数值总量（例如 OpenAI `total_tokens`），另存 `provider_total_tokens`；绝不把整个 raw usage
写进 SQLite，也不把 SDK 归一化合计冒充 provider 原始值。每个 adapter 的提取器独立测试，
未认识的形状保持未报告。

现有 `messages.usage` 扩展为可选的详细字段，但仍只承担消息展示，不作为长期统计的唯一
事实来源。历史消息可以回填 input/output 和 provider/model；缓存、reasoning 和真实 step
数标记为历史未知，不做推测。

## 耗时阶段与 UI

一次模型/工具循环拆为：

```text
模型请求开始
→ 首个输出
→ 工具参数开始
→ 工具参数完成
→ 本地工具执行开始
→ 本地工具执行完成
→ 下一步模型请求
```

事件来源：

- `onLanguageModelCallStart/End`：模型请求；
- `StepResult.performance`：首包、吞吐与 step 耗时；
- `tool-input-start → tool-call`：参数生成；
- `onToolExecutionStart/End`：本地执行；
- 首次 `file-patch`：用户首次看到产物变化。

UI 状态改为：

- `preparing`：准备参数；
- `executing`：本地执行；
- `success`；
- `recoverable_error`；
- `fatal_error`；
- `aborted`。

`tool-input-start` 只能显示“准备补丁/准备编辑”，`onToolExecutionStart` 后才能显示“执行
补丁/执行编辑”。本地执行超过 500ms 才显示性能警告。可恢复错误用黄色，最终失败用红色；
恢复成功后保留“曾失败 N 次，已切换安全编辑”的说明。

每条 assistant 消息提供“运行诊断”入口，显示总耗时、阶段分布、step 数、工具时间线、
最慢步骤、错误恢复和详细 token。独立“模型用量”页面支持日期、provider、model、项目、
调用场景筛选，并显示缓存命中率、平均每轮 token 和平均每次模型请求 token。

## MagicString 可靠编辑

### 采用边界

MagicString 是 VFS 内部的编辑执行引擎，不负责搜索、路径权限、revision、跨文件事务或错误
恢复。`SessionVfs` 继续保存：

```ts
Map<string, {
  content: string
  revision: number
}>
```

每次批量编辑临时基于当前 `content` 创建 `MagicString`。成功提交后写回字符串并增加
revision；不长期保存 MagicString 实例，不生成 sourcemap。

`magic-string` 必须加入直接依赖，不能依赖当前 lockfile 中的传递依赖。

### Anchor Registry

`search_files` 为每个命中额外返回 `matchId`。主进程保存：

```ts
{
  id,
  path,
  revision,
  startOffset,
  endOffset,
  contentHash
}
```

搜索预览仍可截断，但必须明确标记“不可作为旧文本锚点”。模型直接用 `matchId` 修改，不复制
预览内容。

新增 `capture_range`，用于搜索无法表达的任意代码块。输入契约与现有读取工具对齐：

- `path`；
- `start_line` / `end_line`：1 起、两端行均包含，`end_line` 缺省等于开始行；
- `start_column` / `end_column`：1 起，以 JavaScript UTF-16 code unit 计数，结束列包含；
- 列缺省时取起始行行首到结束行行尾；
- `include_trailing_newline` 缺省 false，需要整行删除时可显式包含结束行后的换行。

内部统一转换成 UTF-16 字符偏移的半开区间 `[startOffset, endOffset)`。工具返回精确、不截断
的正文和 `anchorId`；主进程记录相同的 revision、offset 和 hash。越界、位于 surrogate pair
中间或不存在的 trailing newline 都返回结构化错误。

### 字符串操作

新增 `apply_string_edits`：

```ts
type StringEditOperation =
  | { type: 'replace'; anchorId: string; content: string }
  | { type: 'remove'; anchorId: string }
  | { type: 'insert_before'; anchorId: string; content: string }
  | { type: 'insert_after'; anchorId: string; content: string }
```

所有 anchor 必须是非空范围。执行前先按 anchor 合并操作，再统一映射为一次
`MagicString.update(start, end, composedContent)`：

- replace：核心内容为新内容；
- remove：核心内容为空串；
- 只有 insert：核心内容保留 anchor 原文；
- insert_before：按请求数组顺序拼到核心内容之前；
- insert_after：按请求数组顺序拼到核心内容之后。

暂不开放任意正则替换和文本范围移动。文件移动继续用 `move_file`。

### 原子提交

一次 `apply_string_edits`：

1. 验证所有 anchor 存在；
2. 验证 path、revision 和原文 hash；
3. 检查同文件区间是否非法重叠；
4. 按文件创建 MagicString，并以原始字符串坐标执行全部操作；
5. 先为所有文件计算最终字符串；
6. 所有文件都成功后再统一提交 VFS；
7. 提交成功才发 Monaco patch 事件。

任何失败都会回滚整个批次，并返回具体 operation 索引、文件、错误码和恢复动作。JavaScript
UTF-16 索引、emoji/surrogate pair 和 CRLF/LF 必须纳入测试。

区间组合规则必须确定：

- replace/remove 使用非空半开区间；相邻区间允许，部分或完全重叠禁止；
- 同一 anchor 最多一个 replace 或 remove；
- 同一 anchor 可组合 `insert_before + replace/remove + insert_after`；
- 同一 anchor 多个 before/after 分别按请求数组顺序拼接；
- 相邻 anchor 即使共享字符边界，也各自合成为独立的非空区间 update，不调用
  `prependLeft` / `appendRight`，因此不存在插入附着到相邻 remove 后消失的问题；
- 同一批次先把组合操作规范化和冲突检测完，再调用 MagicString，不能依赖库抛错决定业务
  语义。

### 旧工具定位

- `edit_file`、`multi_edit_file` 保留兼容，内部可逐步改用 MagicString。
- `apply_patch` 保留给短行、格式规整的小 hunk，以及 Add/Delete。
- 涉及截断行、长数组、大段 Vue 模板或第一次补丁失败时，切换
  `capture_range/search matchId + apply_string_edits`。
- `write_file`、`move_file`、`copy_file`、`delete_file` 保持职责。
- 自检增加单行超过 800 字符的“可编辑性警告”，并要求大型数组、columns、options
  多行格式化；警告不阻止保存。

## 结构化错误与熔断

文件工具统一返回：

```ts
interface ToolResult {
  ok: boolean
  code?: ToolErrorCode
  message: string
  recovery?: {
    nextTool: string
    reason: string
  }
  affectedFiles?: string[]
}
```

错误码至少包括：

- `ANCHOR_STALE`
- `ANCHOR_NOT_FOUND`
- `RANGE_OVERLAP`
- `MATCH_NOT_FOUND`
- `MATCH_AMBIGUOUS`
- `PATCH_FORMAT_INVALID`
- `FILE_NOT_FOUND`
- `FILE_ALREADY_EXISTS`
- `INVALID_PATH`
- `SYNTAX_CHECK_FAILED`
- `TOOL_EXECUTION_FAILED`

恢复规则：

- 第一次可恢复失败：返回精确原因和下一工具。
- 同文件第二次出现相同补丁错误：本轮不再允许该文件走文本补丁，要求 MagicString anchor。
- 连续三次写工具失败：暂停写入，必须先重新定位或读取。
- 相同工具、目标和参数指纹不得重复调用。
- AI SDK `prepareStep` 根据 `RunContextLedger` 执行工具限制，不能只依赖模型理解文字。

上游 429/5xx、网络和超时与本地工具错误分开记录。重试耗尽后，tools 模式保留此前已成功
提交的完整操作；未提交的 MagicString 批次不保存。SQLite、artifact 或 VFS 一致性错误属于
致命错误，立即锁住后续写入。

## 上下文治理

### RunContextLedger

每轮维护：

```ts
interface RunContextLedger {
  fileRevisions: Map<string, number>
  activeAnchors: Map<string, Anchor>
  activatedSkills: Set<string>
  completedWrites: WriteSummary[]
  recentErrors: ToolErrorSummary[]
  cumulativeUsage: DetailedUsage
  toolCallCount: number
}
```

账本只活在当前生成回合；长期指标由 SQLite 表保存。

### 工具历史压缩

`prepareStep` 在下次模型请求前安全改写消息：

- 成功写工具的完整 content/patch 参数替换成 path、revision 和结果摘要；
- 失败写工具的完整参数替换成错误码、目标和恢复动作；
- anchor 已成功应用后删除其完整范围正文；
- 文件 revision 变化后删除该文件旧 revision 的 search/read/capture 结果；
- 同一技能正文只保留一份，重复激活只返回短提示；
- 当前下一步仍需使用的最新读取/anchor 内容必须保留。

工具调用与结果必须成对删除或成对替换，不能产生 AI SDK 非法消息。实现应使用独立的
`compactToolHistory` 纯函数并以假模型做多 step 集成测试，而不是在 `chat-service.ts`
临时拼接。

合法消息形态固定如下：

1. 按 `toolCallId` 选出需要压缩的已完成调用；
2. 从可能包含并行调用和普通文本的 assistant message 中只移除对应 `tool-call` part；
3. 从 tool message 中移除同 ID 的 `tool-result` / approval part；
4. 保留同一消息里未被选中的并行调用、结果、文本和 reasoning；
5. 移除过滤后为空的 assistant/tool message；
6. 把全部已压缩事实合并为唯一、可替换的 `<tool_ledger>` 文本消息，放在被压缩序列之后；
7. 下一次压缩更新既有 ledger，不重复追加；
8. 调用 AI SDK `modelMessageSchema` 验证，再交给下一 step。

ledger 使用 provider 最兼容的 user-role 系统注记形态，并明确标注“运行时工具账本，不是用户
新要求”。不能保留伪造或 schema 不匹配的 tool-call 输入。实现可复用/对照 AI SDK
`pruneMessages` 的配对逻辑，但需要支持按 call ID 替换事实摘要。

### 目标模板路由

多端项目每轮只为活动目标注入完整模板：

1. 用户本轮明确端类型；
2. 当前文件 manifest/路径能唯一确定；
3. 项目只有一个目标；
4. 否则注入多个目标的简短兼容契约，但不注入所有完整模板。

例如 RBAC 后台只注入 admin 全文，landing/web 保留一句兼容说明。

### 预算

64K 模型默认：

- 20 次工具调用：软阈值，强制压缩并要求合并操作；
- 30 次：禁止重复读取未变化文件；
- 40 次：硬上限，保存已完成修改并结束；
- 累计输入达到 `3 × contextWindow`：强压缩；
- 达到 `5 × contextWindow`：保存当前完整成果并结束。

`stopWhen` 只能阻止下一 step，挡不住单个 step 一次返回超过剩余额度的并行工具调用。因此
所有工具 execute 外层共用同步的 `ToolBudgetGate.reserve(callId)`：按调用到达顺序预留名额，
只允许前 40 个真正执行，超出的调用返回 `TOOL_BUDGET_EXCEEDED`，不得产生副作用。step 结束
后立即停止模型循环。参数生成已经发生的 token 仍计入用量。

provider 未报告 input token 时，预算使用本地保守估算：对当 step 最终发送的
instructions、messages 和 tool schema 序列化字符数按 `ceil(chars / 2)` 估算输入 token，并
标记 `usage_estimated=true`。已报告字段永远优先；估算只用于熔断和诊断展示，不能写入长期
“provider 报告”字段。若连消息构造都失败，仍以工具调用 40 次硬闸门兜底。

工具集合在一轮内尽量保持稳定，以维持 provider 的 prompt cache；只有能力本来未启用、
新项目无文件或发生熔断时才缩减。缓存效果由真实 cache read/write 数据验证。

## 错误恢复语义

- 可恢复工具错误不把整轮直接标记为 error；模型成功恢复后 run 仍可 complete。
- 上游错误耗尽重试后 run 为 error，已提交的 tools 操作可生成 artifact。
- 未提交的 MagicString 批次、markers 半文件和过期 anchor 永不进入 artifact。
- 用户主动中止时保留已成功提交的完整工具操作。
- 致命本地错误锁住写入，并禁止创建与 VFS 状态不一致的新 artifact。
- 应用重启后仅把未完成追踪标为 interrupted，不尝试恢复模型 stream。

## 测试策略

### VFS 与 MagicString

- replace/remove/insert_before/insert_after；
- 同文件多个区间、跨文件批次；
- 操作顺序不改变原始坐标；
- 重叠区间整批回滚；
- revision/hash 失效；
- capture_range 的 1 起坐标、包含端点、trailing newline 和 UTF-16 边界；
- 同 anchor 多次插入顺序、相邻范围、包含/部分重叠和组合操作；
- 800～1700 字符超长行；
- 中文、emoji、surrogate pair；
- CRLF/LF；
- Monaco 事件只在事务成功后发出。

### 上下文

- 成功和失败的大补丁正文不进入下一 step；
- 旧 revision 读取被清理，当前 anchor 不被提前清理；
- 技能只加载一次；
- 工具调用/结果保持配对；
- 混合文本 + 多个并行工具调用的部分压缩、空消息清理和 ledger 幂等更新；
- 20/30/40 次与 3x/5x 阈值；
- 单 step 超过剩余额度时只有已预留工具有副作用；
- provider usage 缺失时的本地估算与 estimated 标记；
- 相同错误和调用指纹熔断；
- 压缩后模型仍知道成功写入和恢复动作。

### 用量与留存

- 每个 token 字段及 reported_calls；
- 多 step 累加和中途错误；
- 未报告、明确 0、部分报告；
- provider/model/project/场景聚合；
- `NULL` 维度规范化、provider/project 删除后唯一键稳定；
- 多 step run 在同日同维度只计一次，跨午夜按日各计一次；
- `model_usage_run_days` 清理不改变已经聚合的日数据；
- SDK total 与 allowlist 提取的 provider total 分离；
- 7 天清理不删除长期用量；
- 历史回填不伪造缓存和 step。

### 遥测和 UI

- 参数生成与工具执行耗时分开；
- 刷新恢复 7 天内时间线；
- 路径、URL、搜索词、密钥和错误脱敏；
- 每类内置工具的 sanitizer 白名单、未知/MCP 工具不保存字段值；
- SQLite 中不存在 prompt、reasoning、文件和补丁正文；
- 可恢复错误最终成功、上游错误和致命错误的不同展示。

### 固定基准

维护一个不含用户数据的合成 RBAC fixture，稳定复现 7 文件、25KB、5 文件修改和超长行。
改造前后记录总耗时、首次文件时间、step 数、工具数、各类 token、缓存命中和失败重试。

## 实施顺序

1. 新增详细 usage 类型、追踪表、7 天清理和长期聚合，先建立基线。
2. 接入 AI SDK 生命周期回调，修正 UI 的 preparing/executing 语义。
3. 引入文件 revision、AnchorRegistry、MagicString 和结构化错误。
4. 新增 `capture_range`、matchId、`apply_string_edits`，保留旧工具。
5. 增加重复错误和重复调用熔断。
6. 实现并验证 `compactToolHistory` 与 `prepareStep` 上下文治理。
7. 接入目标模板路由和分级预算。
8. 用固定基准做改造前后验收，确认性能收益来自真实 step/token 降低。

## 完成标准

- 所有验收指标由自动化测试或固定基准报告覆盖；
- 数据迁移不改变既有项目、消息和 artifact；
- 新诊断表不进入同步触发器；
- 工具错误可在 7 天内事后还原，且不含敏感正文；
- 用量页能按 provider/model 正确展示缓存读写和未报告状态；
- MagicString 路径成为超长行和批量修改的默认可靠方案；
- 工具历史压缩不会破坏 AI SDK 消息合法性或模型继续工作的必要上下文。
