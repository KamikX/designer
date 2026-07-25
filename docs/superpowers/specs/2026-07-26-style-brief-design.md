# 项目级 StyleBrief 与用户驱动主题设计

## 背景

当前设计会话把 `design-seed/assets/theme.css` 当成具体主题母版：新项目复制同一份
字体、间距、圆角、阴影和组件样式，只替换少量颜色 token。即使品牌色不同，最终产物
仍共享同一套视觉 DNA。`target-admin` 又提供了默认导航、卡片、明暗和品牌色注入方式，
而项目级风格描述没有稳定存储，导致用户偏好容易被模板和后续上下文稀释。

本次调整要把设计质量基线与具体视觉风格拆开：`design-seed` 只提供设计方法、token
契约和质量护栏，项目最终风格由用户自然语言定义，并作为项目级唯一事实来源持续注入。

## 目标

1. 项目持久化一段自由文本 `StyleBrief`，保存用户对整体视觉风格的明确描述。
2. 新建项目时允许用户直接填写风格描述，不要求选择预设风格。
3. 用户在对话中明确改变整体风格时，AI 在生成文件前覆盖项目 `StyleBrief`；局部视觉
   修改不改变它。
4. 每轮设计 prompt 都稳定注入项目 `StyleBrief`，且明确用户意图的优先级。
5. 没有风格信息时先向用户确认；用户跳过后才使用项目间稳定、维度间独立的兜底选择。
6. `design-seed`、`target-admin` 和 `antdv-theme` 不再把某一套具体主题当默认答案。
7. tools 与 markers 两种生成协议都能持久化整体风格变化。

## 非目标

- 不增加预设风格画廊、缩略图或可视化主题编辑器。
- 不把 StyleBrief 拆成固定 JSON 字段，也不尝试从文本中建立可查询索引。
- 不自动分析历史项目来推荐风格。
- 不用正则解析用户自然语言来判断整体或局部修改；这个语义判断由模型按明确契约完成。
- 不重做项目详情设置页。创建后修改 StyleBrief 的主要入口是设计对话。

## 方案选择

采用项目表自由文本字段，而不是结构化 JSON 或产物内文件。

- 自由文本能完整保留“克制、像工业仪表、避免高饱和蓝”等开放描述，不受固定枚举限制。
- 项目表是项目元数据现有事实来源，StyleBrief 不应跟某个 artifact 版本绑定。
- AI 通过专用工具或 markers 标记更新，下一轮从项目表重新读取；本轮通过工具结果或标记
  解析结果继续使用新值。

## 数据模型与接口

### 项目字段

`projects` 新增：

```ts
styleBrief: text('style_brief').notNull().default('')
```

对应共享契约：

```ts
interface Project {
  styleBrief: string
}

interface CreateProjectInput {
  styleBrief?: string
}
```

空字符串表示用户尚未定义整体风格。老项目通过迁移默认得到空字符串，不改变现有行为。

### 仓储方法

新增 `setProjectStyleBrief(id, styleBrief)`：

- 对输入 `trim()`；
- 覆盖旧值，不做拼接；
- 更新 `updatedAt`，因为整体风格变化属于项目实质变更；
- 项目不存在时返回 `null`。

创建项目时保存经过 `trim()` 的初始 StyleBrief。

### 创建界面

在“项目描述”之后增加一个自由文本输入：

- 标签：`视觉风格（可选）`
- 提示用户可以描述气质、配色、字体、密度、圆角、参考对象和不希望出现的风格。
- 这是普通 textarea，不提供预设风格卡片；可视化风格配置属于后续范围。

## Prompt 优先级与数据流

设计会话的稳定区增加“项目视觉方向”段，位于端契约与端模板之前。

冲突优先级固定为：

1. 用户本轮明确表达的整体风格变更；
2. 项目 `StyleBrief`；
3. 当前端模板的产品结构与交互约束；
4. `design-seed`、craft 与组件库的质量护栏；
5. 无信息时的 fallback。

端模板不能用自己的默认审美覆盖前两项。用户只要求局部变化时，项目 StyleBrief 仍约束
其余界面。

### 首次生成

1. 创建项目时填写了 StyleBrief：直接注入并生成，不重复提问。
2. StyleBrief 为空，但当前用户消息包含明确风格：先持久化用户的整体风格表述，再生成。
3. 两处都没有风格信息，且项目还没有任何 artifact 文件：在第一次写文件前调用
   `ask_user`，提供 2–3 个结合当前业务的具体方向，并允许自由输入。
4. 用户回答：把答案整理成简短自由文本 StyleBrief，持久化后生成。
5. 用户跳过：不写入伪造的用户偏好，使用 fallback 完成本轮。

“跳过”只控制当前首次生成回合，不新增项目或会话字段。fallback 成功生成首个 artifact
后，后续回合即使 StyleBrief 仍为空也不重复提问；项目仍没有文件（例如首次生成中止或
失败）时，下一次尝试可以再次确认。这样既不反复打扰已有项目，也不把一次跳过误当成
永久风格选择。

StyleBrief 为空但已经有 artifact 文件时（包括迁移后的老项目、首次 fallback 已生成、
以及用户清除 StyleBrief 的已有项目），唯一行为是延续当前文件体现出的视觉语言：
不重新询问、不启用 fallback、不主动重做主题。用户之后明确提出新的整体风格时，才保存
新 StyleBrief 并覆盖现有视觉语言。

### 后续整体风格变化

以下属于项目级更新：

- “整体改成深色工业控制台”
- “以后都用更锐利、紧凑的风格”
- “整个项目换成日式杂志感，减少圆角”

模型必须先持久化新 StyleBrief，再修改文件。新值覆盖旧值，避免把互相冲突的历史要求
无限拼接。

以下属于局部修改，不更新 StyleBrief：

- “这个按钮改成绿色”
- “当前表格表头深一点”
- “登录页用深色，其余保持不变”
- “这张卡片不要圆角”

模型在不确定是整体还是局部时先问一句，不自行扩大影响范围。

## 两种协议的持久化

### Tools 协议

设计会话新增 `set_style_brief` 工具：

```ts
set_style_brief({
  styleBrief: string
})
```

工具只在项目设计会话注册。描述中写明：

- 仅用于用户明确给出整体风格或回答整体风格确认；
- 必须在写文件前调用；
- 局部组件、单页例外不得调用；
- 传入简洁、可执行的视觉描述，尽量保留用户原话。

成功结果返回已保存的 StyleBrief，提醒模型本轮立即按它生成；项目不存在时返回明确错误。

### Markers 协议

无 tools 能力的模型使用独立标记：

```xml
<antdStyleBrief>
深色工业控制台；高密度；小圆角；冷灰表面；避免霓虹渐变。
</antdStyleBrief>
```

协议要求整体风格变化时先输出该标记，再输出文件。流解析器捕获正文、从用户可见解说中
移除，并把最后一个完整值暂存为本回合的 `pendingStyleBrief`。没有该标记就不改变项目
字段。

markers 路在成功收完流后严格按以下顺序提交：

1. 完成 parser，确认 StyleBrief 标记和所有文件标记均完整；
2. 若存在 `pendingStyleBrief`，同步持久化并确认成功；
3. 只有第 2 步成功后，才把 parser 中的文件灌入 VFS 并创建 artifact。

marker 后面的文件可以继续流式展示，但在上述提交点之前都只是暂存结果。StyleBrief
持久化失败时整轮 markers 文件不进入 VFS/artifact，消息记为错误；这保持了 markers
协议原有的“出错不保存半成品”语义，也保证不会出现新主题文件已经落库、项目风格却仍是
旧值的分裂状态。模型在本轮生成时使用的是自己刚输出的 marker 内容，因此不需要等待
第二次模型请求。

StyleBrief 标记不是产物文件，不能进入 VFS、artifact 或消息正文。

## design-seed 调整

`design-seed` 从“复制具体主题”改成“生成项目主题的工作方法”：

- 删除“完整复制 theme.css、只改少数值”的指令。
- 不再把固定暖白、衬线标题、10px 圆角、44px 按钮和固定阴影当默认。
- 保留 semantic token 的必需类别、交互状态、可访问性和一致性要求。
- 明确先读取项目 StyleBrief，再为当前项目生成完整 `theme.css`。
- StyleBrief 可以决定字体体系、明暗、色温、密度、圆角、边框、阴影和动效；只有可访问性
  与状态语义不能被牺牲。
- `assets/theme.css` 不再作为可复制的具体主题。改成只描述 token 接口的参考文档，避免
  任何合法 CSS 默认值继续形成视觉锚点。
- 通用 design-seed 不再提供落地页版面节奏；页面结构由 `target-*` 模板负责。现有
  `references/layouts.md` 不再是 design-seed 的必读项。

旧的暖橙单值不再天然算错误。`slop-lint` 将 `seed-default-brand` 改为
`legacy-seed-fingerprint`：只有产物同时保留多项旧 seed 特征时才提示仍在复制旧母版，
避免用户恰好指定暖橙时误报。

## target-admin 与 antdv-theme 调整

`target-admin` 继续管理：

- 页面路由、字段、筛选、分页；
- 数据密度与表格状态；
- 权限、危险操作和运营效率。

它不再把“浅色、左侧栏、描边卡片、固定品牌注入位置”视为视觉默认。风格维度改成需要
结合 StyleBrief 的实现检查；没有 StyleBrief 才允许 fallback。

`antdv-theme` 的配方表降级为示例映射，而非封闭选项。组件 token 必须从 StyleBrief 和
项目 `theme.css` 推导，同时继续保证 `colorPrimary`、圆角、字体、明暗模式与页面一致。

## Fallback

Fallback 只在以下条件同时满足时启用：

- 项目 StyleBrief 为空；
- 项目还没有任何 artifact 文件；
- 当前用户消息没有明确风格；
- 用户跳过风格确认。

项目 ID 继续保证项目内稳定，但不再用同一个 1–5 数字选择所有维度。每个维度使用
`projectId + dimension` 独立派生，例如：

- 色彩家族；
- 明暗；
- 密度；
- 几何/圆角；
- 表面处理；
- 导航形态。

fallback 结果只进入 prompt，不写成用户 StyleBrief，因为它不是用户选择。

## 错误处理与边界

- 空白 StyleBrief 归一为空字符串；显式传空字符串允许清除项目风格。
- “清除项目风格 / 以后不固定整体风格 / 恢复为未指定风格”等明确全局表达使用
  `set_style_brief({ styleBrief: '' })` 或空的 `<antdStyleBrief></antdStyleBrief>`；
  清除后已有 artifact 不变，后续修改延续当前文件的视觉语言；只有项目还没有文件时，
  下一轮才重新触发首次风格确认。
- StyleBrief 只作为数据插入 system prompt，组装时转义 markdown fence，不能让其改变
  system prompt 结构。
- tool 更新失败时工具返回错误，模型不得继续写文件；marker 更新失败时丢弃本轮暂存文件
  并把消息记为错误，避免本轮产物和下轮事实来源不一致。
- markers 中同一回合出现多个 StyleBrief 标记时，以最后一个完整标记为准。
- 中止或解析到不完整标记时不更新。
- 老项目 StyleBrief 为空且已有 artifact 时，不反推、不迁移、不重新确认，继续沿用当前
  文件的视觉语言；老项目没有任何 artifact 时才遵循首次生成流程。

## 测试策略

### 数据与 IPC

- 新建项目保存并 trim StyleBrief。
- 老项目迁移后字段为空字符串。
- 更新、覆盖、清除 StyleBrief；不存在项目返回 `null`。
- 共享类型和 preload/IPC 契约保持一致。

### Prompt

- 非空 StyleBrief 出现在稳定区、端模板之前，并转义 fence。
- 空 StyleBrief 不注入伪标题。
- prompt 明确整体更新与局部例外的判定规则。
- 有 StyleBrief 时 fallback 明确失效。
- StyleBrief 为空但已有文件时，prompt 要求延续现有视觉语言且不启用 fallback。
- 各 fallback 维度独立派生，项目内稳定。

### Tools 与 markers

- `set_style_brief` 成功保存并返回新值。
- 工具只在设计项目注册。
- parser 能跨 chunk 解析 StyleBrief 标记，不把它写入 VFS 或解说。
- 多标记取最后一个；不完整标记不更新。

### 技能与 lint

- design-seed 不再包含“复制 theme.css”“只改这几个”等固定母版指令。
- target-admin 明确 StyleBrief 优先。
- 单独使用旧暖橙不报错；同时命中多项旧 seed 特征时报 fingerprint。

### UI 与全量验证

- 创建弹窗提交 `styleBrief` 并在创建后清空表单。
- 运行相关 Vitest、主进程与 Web 类型检查、ESLint，最后运行全量测试。

## 验收标准

1. 两个相同后台 brief、不同 StyleBrief 的项目，prompt 不共享任何固定字体、圆角、色温或
   表面风格默认值。
2. 用户明确改变整体风格后，新值当轮生效且下一轮仍存在。
3. 局部样式修改不会覆盖项目 StyleBrief。
4. 用户没有提供风格时仍能完成生成，但 fallback 只作为兜底且维度间不再绑定。
5. tools 与 markers 模型行为一致，不因模型能力不同丢失项目级风格。
6. 旧项目、已有设计稿和现有项目创建流程保持兼容。
