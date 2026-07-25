# 项目级 StyleBrief Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让用户自然语言定义的整体视觉风格成为项目级稳定事实来源，并解除 `design-seed` 对单一主题母版的强绑定。

**Architecture:** 在 `projects` 增加自由文本 `styleBrief`，通过创建表单、tools 协议的专用工具和 markers 协议的暂存标记写入。Prompt 在稳定区注入明确优先级；已有文件但无 StyleBrief 时延续当前视觉，只有首次无文件项目才确认或 fallback。设计技能只保留结构和质量护栏。

**Tech Stack:** TypeScript、Electron IPC、SQLite/Drizzle、AI SDK tools、Vitest、Vue 3 `<script setup>`、antdv-next。

---

## 文件职责

- `src/shared/types.ts`：Project、CreateProjectInput、DesignerApi 的跨进程唯一契约。
- `src/main/db/schema.ts`、`src/main/db/migrations/*`、`src/main/db/migrations.ts`：StyleBrief 持久化和迁移。
- `src/main/db/repo/project.ts`：创建、覆盖、清除项目 StyleBrief。
- `src/main/ai/style-brief.ts`：StyleBrief prompt、fallback 签名和 tools 协议工具，避免继续膨胀 `chat-service.ts`。
- `src/main/ai/file-stream-parser.ts`：markers 协议解析与 `pendingStyleBrief` 暂存。
- `src/main/ai/chat-service.ts`：注册工具、组装 prompt、按事务顺序提交 markers。
- `src/main/ai/prompts/{index,protocol,targets,craft-core}.ts`：优先级、协议和 fallback 契约。
- `resources/skills/{design-seed,target-admin,antdv-theme}/`：从固定主题母版改为用户风格驱动。
- `src/main/ai/slop-lint.ts`：单色误报改为旧 seed 组合指纹。
- `src/renderer/src/pages/home/components/CreateProjectModal.vue`：自由文本 StyleBrief 创建入口。

### Task 1: 数据模型、迁移与项目仓储

**Files:**
- Modify: `src/shared/types.ts`
- Modify: `src/main/db/schema.ts`
- Create: `src/main/db/migrations/0012_*.sql`（由 `pnpm db:generate` 生成）
- Modify: `src/main/db/migrations/meta/*`（由生成器更新）
- Modify: `src/main/db/migrations.ts`（确认新迁移被导入）
- Modify: `src/main/db/repo/project.ts`
- Create: `src/main/db/repo/project.test.ts`

- [ ] **Step 1: 写仓储失败测试**

覆盖：创建时 trim、覆盖旧值、空字符串清除、不存在项目返回 `null`。

- [ ] **Step 2: 运行测试并确认因缺少字段/方法而失败**

Run: `pnpm vitest run src/main/db/repo/project.test.ts`

- [ ] **Step 3: 添加共享类型和 schema 字段**

`Project.styleBrief` 必填字符串，`CreateProjectInput.styleBrief` 可选；数据库列
`style_brief TEXT NOT NULL DEFAULT ''`。

- [ ] **Step 4: 生成并检查迁移**

Run: `pnpm db:generate`

确认只新增 `style_brief`，不修改历史迁移。

- [ ] **Step 5: 实现仓储方法**

`createProject` 保存 trim 后的值；`setProjectStyleBrief` 覆盖并更新 `updatedAt`。

- [ ] **Step 6: 运行仓储测试**

Run: `pnpm vitest run src/main/db/repo/project.test.ts src/main/db/migrate-safety.test.ts`

- [ ] **Step 7: 提交**

```bash
git add src/shared/types.ts src/main/db/schema.ts src/main/db/migrations src/main/db/migrations.ts src/main/db/repo/project.ts src/main/db/repo/project.test.ts
git commit -m "feat: 持久化项目视觉方向"
```

### Task 2: StyleBrief prompt 与独立 fallback

**Files:**
- Create: `src/main/ai/style-brief.ts`
- Create: `src/main/ai/style-brief.test.ts`
- Modify: `src/main/ai/prompts/index.ts`
- Modify: `src/main/ai/prompts/targets.ts`
- Modify: `src/main/ai/prompts/targets.test.ts`
- Modify: `src/main/ai/prompts/craft-core.ts`
- Modify: `src/main/ai/chat-service.ts`

- [ ] **Step 1: 写 prompt 失败测试**

断言：

- 非空 StyleBrief 被 fence 转义，出现在端模板之前；
- 空 StyleBrief + 无文件要求首次确认，跳过才 fallback；
- 空 StyleBrief + 已有文件要求延续现有视觉；
- fallback 的色彩、明暗、密度、几何、表面、导航分别由不同 key 派生且项目内稳定；
- 有 StyleBrief 时不出现 fallback 指令。

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm vitest run src/main/ai/style-brief.test.ts src/main/ai/prompts/targets.test.ts`

- [ ] **Step 3: 实现纯函数**

在 `style-brief.ts` 实现：

```ts
renderStyleBriefPrompt(project, hasFiles): string
styleFallback(projectId): StyleFallback
```

只输出 prompt，不读写数据库。用现有 fence 转义约定处理用户文本。

- [ ] **Step 4: 调整 prompt 顺序与端契约**

把 StyleBrief 段放到 target contract/template 之前；删除单一 `styleDice`，改为独立
fallback 签名；`CRAFT_CORE` 加入明确优先级阶梯和整体/局部更新判定。

- [ ] **Step 5: 运行测试**

Run: `pnpm vitest run src/main/ai/style-brief.test.ts src/main/ai/prompts/targets.test.ts src/main/ai/prompts/chat.test.ts`

- [ ] **Step 6: 提交**

```bash
git add src/main/ai/style-brief.ts src/main/ai/style-brief.test.ts src/main/ai/prompts src/main/ai/chat-service.ts
git commit -m "feat: 注入项目级视觉方向"
```

### Task 3: Tools 协议整体风格更新

**Files:**
- Modify: `src/main/ai/style-brief.ts`
- Modify: `src/main/ai/style-brief.test.ts`
- Modify: `src/main/ai/chat-service.ts`
- Modify: `src/main/ai/session-vfs.ts`
- Modify: `src/main/ai/session-vfs.test.ts`
- Modify: `src/main/ai/tool-label.ts`（若现有工具标签映射位于该文件）

- [ ] **Step 1: 写工具失败测试**

构造假的 `save` 回调，断言：

- `set_style_brief` trim 并保存；
- 空字符串可清除；
- 成功结果回显当轮生效的新值；
- 保存失败返回错误、丢弃本回合此前的 VFS 改动并锁住后续写入；
- 锁住后所有文件写工具都返回同一个明确错误，不会生成 artifact；
- 工具只在项目设计会话注册，纯聊天不可见。

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm vitest run src/main/ai/style-brief.test.ts`

- [ ] **Step 3: 实现 `buildStyleBriefTools`**

工具描述明确整体/局部边界，并只在 project 设计会话合并进 ToolSet。

给 `SessionVfs` 增加会话级写入闸门：StyleBrief 保存失败时调用一次
`blockWrites(reason, { discardChanges: true })`，把本回合状态恢复到 original，并让所有
后续 mutator 在修改前抛同一个 `VfsError`。不能只依赖模型理解错误文本；闸门是“更新失败
后绝不生成 artifact”的程序保证。

- [ ] **Step 4: 补工具展示标签并运行测试**

Run: `pnpm vitest run src/main/ai/style-brief.test.ts src/main/ai/session-vfs.test.ts src/main/ai/tools.test.ts`

- [ ] **Step 5: 提交**

```bash
git add src/main/ai/style-brief.ts src/main/ai/style-brief.test.ts src/main/ai/chat-service.ts src/main/ai/session-vfs.ts src/main/ai/session-vfs.test.ts src/main/ai/tool-label.ts
git commit -m "feat: 支持对话更新整体视觉方向"
```

### Task 4: Markers 协议暂存与提交顺序

**Files:**
- Modify: `src/main/ai/prompts/protocol.ts`
- Modify: `src/main/ai/file-stream-parser.ts`
- Modify: `src/main/ai/file-stream-parser.test.ts`
- Modify: `src/main/ai/chat-service.ts`

- [ ] **Step 1: 写 parser 失败测试**

覆盖 chunk=1/3/7/1000、标记不进入 narration/VFS、多个完整标记取最后一个、空标记清除、
未闭合 StyleBrief 标记不更新；另暴露 `hadUnclosedFile`，即使为兼容旧行为自动收尾文件，
事务提交层也能知道文件标记并不完整。

- [ ] **Step 2: 运行 parser 测试确认失败**

Run: `pnpm vitest run src/main/ai/file-stream-parser.test.ts`

- [ ] **Step 3: 实现 parser 状态**

增加 `pendingStyleBrief: string | null`、`hadUnclosedFile` 与 StyleBrief 行/正文状态，
不把 StyleBrief 加入 `ParserEvent` 的文件事件或 `hasChanges`。保留无风格更新回合的自动
收尾兼容行为，但不能把自动收尾伪装成“文件标记完整”。

- [ ] **Step 4: 写提交顺序测试**

抽取一个小型纯函数或可注入回调，覆盖三条收尾路径：

- 完整成功：`save style -> ingest files`；
- StyleBrief 保存失败：不 ingest，整轮转 error；
- 正常流结束但存在 `pendingStyleBrief` 且任一 `<antdFile>` 未闭合：不保存、不 ingest、
  不创建 artifact；
- 流异常或用户 abort 且存在 `pendingStyleBrief`：不保存 StyleBrief、不 ingest 本轮
  markers 文件，并清空暂存。

没有 `pendingStyleBrief` 的 abort 保留当前行为，避免借本功能改变既有中止语义。

- [ ] **Step 5: 实现 markers 提交流程**

只有正常完整结束才先保存 `pendingStyleBrief`、成功后 `vfs.ingest`。异常分支不得再像
当前实现一样无条件 `parser.finish()` + `vfs.ingest()`；abort 且存在待提交风格时同样
丢弃两类暂存，避免“文件是新主题、项目仍是旧 StyleBrief”。更新 FILE_PROTOCOL 示例与规则。

- [ ] **Step 6: 运行相关测试**

Run: `pnpm vitest run src/main/ai/file-stream-parser.test.ts src/main/ai/file-stream-parser*.test.ts`

- [ ] **Step 7: 提交**

```bash
git add src/main/ai/prompts/protocol.ts src/main/ai/file-stream-parser.ts src/main/ai/file-stream-parser.test.ts src/main/ai/chat-service.ts
git commit -m "feat: 为长尾模型持久化视觉方向"
```

### Task 5: 去除固定主题锚点并调整 lint

**Files:**
- Modify: `resources/skills/design-seed/SKILL.md`
- Delete: `resources/skills/design-seed/assets/theme.css`
- Add: `resources/skills/design-seed/references/theme-contract.md`
- Modify: `resources/skills/design-seed/references/layouts.md`（移除通用必读关系或迁移说明）
- Modify: `resources/skills/target-admin/SKILL.md`
- Modify: `resources/skills/antdv-theme/SKILL.md`
- Modify: `src/main/ai/slop-lint.ts`
- Modify: `src/main/ai/slop-lint.test.ts`

- [ ] **Step 1: 写技能契约与 lint 失败测试**

断言 design-seed 不包含“复制 theme.css”“只改这几个”；单独暖橙不报错；旧 seed 的
多项配色、字体、圆角组合命中 `legacy-seed-fingerprint`。

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm vitest run src/main/ai/slop-lint.test.ts src/main/skills/scan.test.ts`

- [ ] **Step 3: 重写 design-seed**

只保留 StyleBrief 读取流程、token 类别、对比度/状态/一致性护栏；用无具体 CSS 值的
`theme-contract.md` 替代可复制主题。

- [ ] **Step 4: 调整 admin 与 antdv 主题技能**

后台模板只管信息架构；视觉维度从 StyleBrief 推导。antdv 配方改为示例映射并继续要求
组件 token 与页面主题一致。

- [ ] **Step 5: 实现组合指纹 lint**

移除单个 `#c96442` 命中，只有同时命中多个旧 seed 特征才报告。

- [ ] **Step 6: 运行相关测试**

Run: `pnpm vitest run src/main/ai/slop-lint.test.ts src/main/skills/scan.test.ts`

- [ ] **Step 7: 提交**

```bash
git add resources/skills src/main/ai/slop-lint.ts src/main/ai/slop-lint.test.ts
git commit -m "refactor: 让设计种子只保留质量护栏"
```

### Task 6: 创建界面和跨进程契约

**Files:**
- Modify: `src/shared/types.ts`
- Modify: `src/main/ipc/index.ts`
- Modify: `src/preload/index.ts`
- Modify: `src/renderer/src/stores/project.ts`
- Modify: `src/renderer/src/pages/home/components/CreateProjectModal.vue`
- Add/Modify: 对应组件测试（若项目已有 Vue Test Utils 基础）

- [ ] **Step 1: 写最小失败测试或类型契约断言**

验证创建请求包含 trim 后的 `styleBrief`，创建成功后表单清空；若当前没有组件测试基础，
用抽取的表单 payload 纯函数做 Vitest，不为一个字段引入新的测试框架。

- [ ] **Step 2: 运行测试确认失败**

Run: 对应单测命令。

- [ ] **Step 3: 实现创建表单**

新增自由文本 textarea，不加预设卡片；提交 `styleBrief`，成功后清空。

- [ ] **Step 4: 补项目更新 IPC（供 AI 工具以外的领域接口复用）**

共享 DesignerApi、IPC、preload 和 store 保持一处一行的现有模式。

- [ ] **Step 5: 运行类型检查和 UI 相关测试**

Run: `pnpm typecheck:web && pnpm typecheck:node`

- [ ] **Step 6: 提交**

```bash
git add src/shared/types.ts src/main/ipc/index.ts src/preload/index.ts src/renderer/src/stores/project.ts src/renderer/src/pages/home/components/CreateProjectModal.vue
git commit -m "feat: 新建项目时支持描述视觉风格"
```

### Task 7: 全量验证与回归检查

**Files:**
- Modify: `CLAUDE.md`
- Modify: `docs/prompt-skills-v2.md`（只更新已改变的现状描述）

- [ ] **Step 1: 更新维护文档**

记录 StyleBrief 是风格唯一事实来源、优先级、design-seed 新职责和两协议更新方式。

- [ ] **Step 2: 检查最终 diff**

Run: `git diff --check`

确认未修改历史迁移、没有把 StyleBrief 写进 artifact 文件、没有遗留固定主题引用。

- [ ] **Step 3: 运行仓库交付三件套**

```bash
pnpm typecheck
pnpm lint
pnpm vitest run
```

Expected: 全部退出码 0，无失败测试。

- [ ] **Step 4: 针对验收标准复核**

用单测或 prompt 快照确认：

- 不同 StyleBrief 不共享固定视觉默认；
- tools/markers 均持久化；
- 局部修改契约不更新；
- 已有文件无 StyleBrief 时延续当前视觉；
- fallback 只用于首次无文件且跳过确认。

- [ ] **Step 5: 提交文档与最终修正**

```bash
git add CLAUDE.md docs/prompt-skills-v2.md
git commit -m "docs: 记录用户驱动主题链路"
```
