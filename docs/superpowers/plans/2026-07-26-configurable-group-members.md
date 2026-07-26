# Configurable Group Members Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让协作群组支持逐个创建成员、成员级模型与技能、结构化高亮提及，以及可解释的接力循环保护。

**Architecture:** 群组仍存于 `conversations.settings`，成员只保存完整 `GroupMember[]`；运行时 guard 把缺失或损坏数据视为空群。提及和循环检测收敛为纯函数，主进程编排只消费已配置成员；Vue 层拆分成员编辑、成员列表和 mention 渲染组件。

**Tech Stack:** Electron、TypeScript、Vue 3 `<script setup>`、Pinia、Antdv Next、AI SDK、Drizzle SQLite、Vitest

---

## 文件结构

- `src/shared/types.ts`：新增成员、模板、建群输入和停止事件契约。
- `src/shared/group-members.ts`：完整成员对象数组的运行时 guard 和展示归一化，主进程与渲染层共用。
- `src/main/ai/group-members.ts`：成员草稿校验、持久化成员生成和运行时 Agent 解析。
- `src/main/ai/group-members.test.ts`：成员数据纯逻辑测试。
- `src/shared/group-mentions.ts`：结构化提及的生成、tokenize、模型文本和 Markdown 转换。
- `src/shared/group-mentions.test.ts`：提及边界、代码区和自然名称格式测试。
- `src/main/ai/group-chain.ts`：访问次数、重复边和跳数保护纯逻辑。
- `src/main/ai/group-chain.test.ts`：循环保护测试。
- `src/main/ai/prompts/group-roles.ts`：保留内置完整角色，并提供可编辑模板 DTO。
- `src/main/ai/prompts/group-roles.test.ts`：迁移到新提及解析器后的内置角色回归测试。
- `src/main/db/repo/conversation.ts`：接受 `CreateGroupInput` 并保存主进程生成的成员。
- `src/main/ai/group-service.ts`：按当前成员解析模型和技能，报告明确停止原因。
- `src/main/ai/group-service.test.ts`：mock DB/AI SDK 后验证成员级模型、技能和停止事件接线。
- `src/main/ipc/index.ts`、`src/preload/index.ts`：更新建群 IPC。
- `src/renderer/src/stores/collab.ts`：使用归一化成员视图，发送只提交会话与文本。
- `src/renderer/src/pages/collab/components/GroupMemberEditor.vue`：编辑单个成员。
- `src/renderer/src/pages/collab/components/GroupMemberList.vue`：成员列表、排序与删除。
- `src/renderer/src/pages/collab/components/CreateGroupModal.vue`：编排建群表单。
- `src/renderer/src/pages/collab/components/GroupMentionTag.vue`：展示一个成员提及。
- `src/renderer/src/pages/collab/components/GroupMentionText.vue`：普通文本消息的提及分片渲染。
- `src/renderer/src/pages/collab/components/GroupMarkdownStream.vue`：群组专用 Comark 配置，注册 mention 链接组件。
- `src/renderer/src/pages/collab/components/GroupMarkdownLink.vue`：把内部 member 链接渲染为 `a-tag`，普通链接保持锚点。
- `src/renderer/src/pages/collab/components/group-components.test.ts`：成员编辑、Mentions 和 tag 的挂载测试。
- `src/renderer/src/pages/collab/components/GroupComposer.vue`：基于已配置成员生成 Mentions 候选。
- `src/renderer/src/pages/collab/components/GroupMessage.vue`：用户/Agent 提及高亮。

### Task 1: 共享成员契约与成员校验

**Files:**
- Modify: `src/shared/types.ts`
- Create: `src/shared/group-members.ts`
- Create: `src/main/ai/group-members.ts`
- Create: `src/main/ai/group-members.test.ts`
- Modify: `src/main/ai/prompts/group-roles.ts`

- [ ] **Step 1: 写成员草稿校验和不可信数据识别的失败测试**

覆盖名称 trim、空人设、保留名称、非法字符、重复名称、无 tools 模型、技能过滤，以及完整对象数组通过、`string[]`/损坏对象数组拒绝。

- [ ] **Step 2: 运行测试确认 RED**

Run: `pnpm vitest run src/main/ai/group-members.test.ts`

Expected: FAIL，模块或导出尚不存在。

- [ ] **Step 3: 添加最小共享类型与纯函数**

核心契约：

```ts
export interface GroupMember {
  id: string
  name: string
  color: string
  duty: string
  deliverable: string
  persona: string
  modelRowId: string
  skillIds: string[]
}

export type GroupMemberDraft = Omit<GroupMember, 'id'>
export interface CreateGroupInput {
  name: string
  members: GroupMemberDraft[]
}
```

展示归一化放在 `src/shared/group-members.ts`，不得从 renderer 导入 `src/main`。用依赖注入的模型/技能清单保持主进程校验函数可单测；持久 ID 由调用方传入的 `createId` 生成。

- [ ] **Step 4: 运行测试确认 GREEN**

Run: `pnpm vitest run src/main/ai/group-members.test.ts`

Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/shared/types.ts src/shared/group-members.ts src/main/ai/group-members.ts src/main/ai/group-members.test.ts src/main/ai/prompts/group-roles.ts
git commit -m "feat: 定义可配置群组成员"
```

### Task 2: 结构化提及与循环保护纯逻辑

**Files:**
- Create: `src/shared/group-mentions.ts`
- Create: `src/shared/group-mentions.test.ts`
- Create: `src/main/ai/group-chain.ts`
- Create: `src/main/ai/group-chain.test.ts`
- Modify: `src/main/ai/prompts/group-roles.test.ts`

- [ ] **Step 1: 写提及解析失败测试**

覆盖 `@[名称](member:ULID)`、精确 `@名称`、相似名称、代码围栏/行内代码排除、自我提及、`@用户` 优先、末尾五行和非法成员 ID。

- [ ] **Step 2: 运行测试确认 RED**

Run: `pnpm vitest run src/shared/group-mentions.test.ts`

Expected: FAIL，模块尚不存在。

- [ ] **Step 3: 实现提及 tokenizer 和转换函数**

输出统一的 mention token：

```ts
type MentionToken =
  | { type: 'text'; text: string }
  | { type: 'member'; memberId: string; name: string }
```

共享解析结果给主进程路由、渲染层普通文本 tag 和 Markdown 安全链接转换，避免三套正则漂移。共享模块不得依赖 Electron、Vue 或数据库。

- [ ] **Step 4: 写循环保护失败测试**

覆盖一次返工允许、成员第三次拒绝、同一有向边第二次拒绝、八跳上限及具体原因。

- [ ] **Step 5: 运行测试确认 RED**

Run: `pnpm vitest run src/main/ai/group-chain.test.ts`

Expected: FAIL，保护器尚不存在。

- [ ] **Step 6: 实现最小 `GroupChainGuard`**

保护器返回 `{ ok: true }` 或 `{ ok: false, reason, message }`，不依赖 Electron 和数据库。

- [ ] **Step 7: 运行相关测试确认 GREEN**

Run: `pnpm vitest run src/shared/group-mentions.test.ts src/main/ai/group-chain.test.ts src/main/ai/prompts/group-roles.test.ts`

Expected: PASS。

- [ ] **Step 8: 提交**

```bash
git add src/shared/group-mentions.ts src/shared/group-mentions.test.ts src/main/ai/group-chain.ts src/main/ai/group-chain.test.ts src/main/ai/prompts/group-roles.test.ts
git commit -m "feat: 增加群组提及与循环保护"
```

### Task 3: 持久化、IPC 与编排接入

**Files:**
- Modify: `src/main/db/repo/conversation.ts`
- Modify: `src/main/ai/group-service.ts`
- Modify: `src/main/ipc/index.ts`
- Modify: `src/preload/index.ts`
- Modify: `src/shared/types.ts`
- Create: `src/main/ai/group-service.test.ts`
- Modify: `src/main/ai/group-members.ts`

- [ ] **Step 1: 写运行时成员解析失败测试**

在 `group-members.test.ts` 增加成员模型解析、模型失效、技能按成员隔离，以及 `GroupSendInput` 不含公共模型字段的测试。

- [ ] **Step 2: 运行测试确认 RED**

Run: `pnpm vitest run src/main/ai/group-members.test.ts`

Expected: FAIL，新解析 API 尚不存在。

- [ ] **Step 3: 实现持久化和 IPC**

`group:create` 接收单个 `CreateGroupInput`；主进程扫描当前模型和技能、校验草稿、生成 ULID 并保存。`GroupSendInput` 只保留 `conversationId` 和 `text`。

- [ ] **Step 4: 实现运行时 Agent 解析**

在 `group-members.ts` 中直接把 `GroupMember` 解析为自身模型和技能；模型不存在、停用、不是 chat 或不支持 tools 时返回带成员名称的明确错误。

- [ ] **Step 5: 重构编排为成员级执行**

每棒解析 `ResolvedGroupAgent`，从模型行取 `providerId/modelId`，按成员 `skillIds` 构造 `skillCatalog`、`buildSkillTools` 和技能根目录。使用 `GroupChainGuard`，停止时发送 `chain-stopped`。

- [ ] **Step 6: 写并运行编排接线测试**

在 `group-service.test.ts` 中 `vi.mock` Electron、DB repo、模型注册表、技能扫描和 AI SDK，验证两个不同成员分别选用自己的模型/技能，以及循环保护发出 `chain-stopped`。mock 必须阻止 better-sqlite3 和 Electron 原生模块加载。

Run: `pnpm vitest run src/main/ai/group-service.test.ts`

Expected: PASS。

- [ ] **Step 7: 运行主进程类型检查与相关测试**

Run: `pnpm typecheck:node && pnpm vitest run src/main/ai/group-members.test.ts src/shared/group-mentions.test.ts src/main/ai/group-chain.test.ts src/main/ai/group-service.test.ts`

Expected: PASS。

- [ ] **Step 8: 提交**

```bash
git add src/main/db/repo/conversation.ts src/main/ai/group-members.ts src/main/ai/group-service.ts src/main/ai/group-service.test.ts src/main/ipc/index.ts src/preload/index.ts src/shared/types.ts src/main/ai/group-members.test.ts
git commit -m "feat: 按成员执行群组模型与技能"
```

### Task 4: 创建群组成员编辑界面

**Files:**
- Create: `src/renderer/src/pages/collab/components/GroupMemberEditor.vue`
- Create: `src/renderer/src/pages/collab/components/GroupMemberList.vue`
- Modify: `src/renderer/src/pages/collab/components/CreateGroupModal.vue`
- Modify: `src/renderer/src/stores/collab.ts`
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`
- Modify: `vitest.config.ts`
- Create: `src/renderer/src/pages/collab/components/group-components.test.ts`

- [ ] **Step 1: 安装并配置 Vue 组件测试依赖**

Run: `pnpm add -D @vue/test-utils happy-dom`

在 `vitest.config.ts` 加入 `@vitejs/plugin-vue`、与 renderer 一致的 Antdv Next Components resolver，以及 Vue/Pinia/VueUse AutoImport（测试配置关闭 dts/eslintrc 生成）。在组件测试文件顶部使用 `// @vitest-environment happy-dom`，通过最小的 Pinia/App provider 工厂挂载组件，不改变其他 Node 测试的默认环境。

- [ ] **Step 2: 提取并测试渲染层草稿纯逻辑**

如 UI 需要临时键、模板复制和排序，放入 `src/renderer/src/pages/collab/member-drafts.ts` 并先写 `member-drafts.test.ts`。

- [ ] **Step 3: 运行测试确认 RED**

Run: `pnpm vitest run src/renderer/src/pages/collab/member-drafts.test.ts`

Expected: FAIL，模块尚不存在。

- [ ] **Step 4: 实现成员列表和编辑器**

遵守 props down/events up：编辑器只通过 `v-model` 暴露一个草稿；列表通过 typed emits 上报编辑、删除和移动。模型只列 enabled、chat、tools 模型；技能按来源与搜索展示。

- [ ] **Step 5: 改造创建弹窗与 store**

弹窗负责模板/空白新增、提交前提示和 IPC plain object 转换。store 只归一化完整 `GroupMember[]`，`createGroup` 接收 `CreateGroupInput`。

- [ ] **Step 6: 写组件挂载测试**

挂载 `GroupMemberEditor` 和 `CreateGroupModal`，验证模板新增、成员字段修改、模型与技能选择、重复名称提示和提交 payload。浏览器 API、`window.api` 与 provider store 用最小 mock。

- [ ] **Step 7: 运行 Web 类型检查和测试**

Run: `pnpm typecheck:web && pnpm vitest run src/renderer/src/pages/collab/member-drafts.test.ts src/renderer/src/pages/collab/components/group-components.test.ts`

Expected: PASS。

- [ ] **Step 8: 提交**

```bash
git add package.json pnpm-lock.yaml vitest.config.ts src/renderer/src/pages/collab src/renderer/src/stores/collab.ts
git commit -m "feat: 支持创建和配置群组成员"
```

### Task 5: Mention 输入与 a-tag 展示

**Files:**
- Create: `src/renderer/src/pages/collab/components/GroupMentionTag.vue`
- Create: `src/renderer/src/pages/collab/components/GroupMentionText.vue`
- Create: `src/renderer/src/pages/collab/components/GroupMarkdownStream.vue`
- Create: `src/renderer/src/pages/collab/components/GroupMarkdownLink.vue`
- Modify: `src/renderer/src/pages/collab/components/GroupComposer.vue`
- Modify: `src/renderer/src/pages/collab/components/GroupMessage.vue`
- Modify: `src/renderer/src/stores/collab.ts`
- Modify: `src/shared/group-mentions.ts`
- Modify: `src/renderer/src/pages/collab/components/group-components.test.ts`

- [ ] **Step 1: 增加面向渲染的 mention token 失败测试**

验证普通文本分片、精确自然名称提及、结构化提及、代码区排除和成员被删除后的退化显示。

- [ ] **Step 2: 运行测试确认 RED**

Run: `pnpm vitest run src/shared/group-mentions.test.ts`

Expected: FAIL，新展示转换行为尚不存在。

- [ ] **Step 3: 实现 Mentions 输入**

候选 value 使用成员稳定 ID；`select` 后写入结构化语法。输入框保持 Enter 发送、Shift+Enter 换行；用户手输和 Agent 输出的精确 `@成员名` 仍由共享解析器识别。

- [ ] **Step 4: 实现 tag 展示和群组专用 Markdown renderer**

用户消息通过 `GroupMentionText` 输出文本节点和 `GroupMentionTag`。Agent Markdown 把有效提及转换成内部 `group-member:` Markdown 链接；`GroupMarkdownStream` 复用现有 highlight 配置并注册 `GroupMarkdownLink` 覆盖链接渲染，内部链接输出 `GroupMentionTag`，普通链接仍输出安全 `<a>`。组件只接收经过成员表解析的 ID/名称，不使用 `v-html`，不修改通用 `MarkdownStream`。

- [ ] **Step 5: 接入停止原因**

store 处理 `chain-stopped`，清理 chaining/speaking 并把服务端 message 显示在当前群。

- [ ] **Step 6: 补 Mentions 和 tag 挂载测试**

挂载 `GroupComposer` 验证候选选择生成规范提及；挂载 `GroupMentionText` 和 `GroupMarkdownStream` 验证旧式/结构化提及产生 `a-tag`，普通链接仍可点击。

- [ ] **Step 7: 运行 Web 类型检查和相关测试**

Run: `pnpm typecheck:web && pnpm vitest run src/shared/group-mentions.test.ts src/renderer/src/pages/collab/components/group-components.test.ts`

Expected: PASS。

- [ ] **Step 8: 提交**

```bash
git add src/renderer/src/pages/collab src/renderer/src/stores/collab.ts src/shared/group-mentions.ts src/shared/group-mentions.test.ts
git commit -m "feat: 高亮群组成员提及"
```

### Task 6: 全量验证与协议回归

**Files:**
- Modify as needed: files above

- [ ] **Step 1: 运行群组专项测试**

Run: `pnpm vitest run src/main/ai/group-members.test.ts src/shared/group-mentions.test.ts src/main/ai/group-chain.test.ts src/main/ai/group-service.test.ts src/main/ai/prompts/group-roles.test.ts src/renderer/src/pages/collab/member-drafts.test.ts src/renderer/src/pages/collab/components/group-components.test.ts`

Expected: PASS。

- [ ] **Step 2: 运行交付前三件套**

Run: `pnpm typecheck && pnpm lint && pnpm vitest run`

Expected: 全部 PASS，无新增 warning。

- [ ] **Step 3: 检查变更范围和兼容性**

Run: `git diff --check && git status --short`

确认 `settings.members: string[]` 不生成成员，发送 payload 不含公共模型字段，同时精确自然 `@成员名` 的路由和高亮仍可工作。

- [ ] **Step 4: 提交修正**

```bash
git add <仅本任务修正的文件>
git commit -m "test: 完善群组成员协议回归"
```
