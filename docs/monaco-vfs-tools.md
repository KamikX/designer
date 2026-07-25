# 代码区 Monaco 化 与 VFS 工具链 技术方案

> 状态：三阶段均已实现 · 2026-07-24（实现中的偏差见 §10，工具集扩充见 §11）
> **VFS 环境的完整设计见 [vfs-design.md](./vfs-design.md)**；本文是落地过程与踩坑记录
> 涉及：工作台布局、代码查看器、AI 文件编辑协议、版本落库

## 0. 现状

| 环节 | 现在的实现 | 位置 |
| --- | --- | --- |
| 工作台分栏 | 左对话固定 `default-size=440 / min=340`，右侧 flex 吃剩余 | `src/renderer/src/pages/project/index.vue:51` |
| 代码视图 | 左 `a-tree` 200px 固定 + 右 `pre` 直出，无高亮 | `WorkspacePane.vue:96`、`CodeViewer.vue:29` |
| AI 产出文件 | `<antdFile path="...">` 全文重写协议 | `src/main/ai/prompts/protocol.ts` |
| 流式解析 | 行缓冲状态机，吐 `file-start / file-delta / file-end` | `src/main/ai/file-stream-parser.ts` |
| 上下文注入 | 每轮把**当前版本全部文件的全文**塞进 system prompt | `src/main/ai/prompts/index.ts:29` |
| 版本落库 | 回合结束用 `writes/deletes` 与父版本合并成新 artifact | `src/main/db/repo/artifact.ts:61` |
| 模型能力 | `model.abilities` 已含 `'tools'` 标记，但链路未使用 | `src/shared/model-caps.ts:56` |

**核心痛点**：改一处颜色也要重吐整份文件，输出 token 差一个数量级；同时输入侧每轮重灌全量文件全文。两头都在浪费。

## 1. 目标 / 非目标

**目标**

- 左侧对话栏默认更窄，预览区更大。
- 代码 tab 拆成「左文件树 + 右 Monaco 只读编辑器」，Shiki 主题高亮，跟随亮/暗主题。
- 建立文件的**单一真值 VFS**，让 AI 通过工具做**局部编辑**而不是全文重写。
- 弱模型（无工具调用能力）继续可用。

**非目标**

- 用户手动编辑代码。编辑器**只读**（`readOnly: true`）。
- 预览在回合进行中热更新（见 §5.3 取舍）。
- 引入 TypeScript / Vue 语言服务、诊断、补全。

## 2. 关键架构判断

原始设想是「把 VFS 存进 monaco-editor，工具通过 monaco 读写行」。这里要反过来：

> **真值放主进程，Monaco 只是它的镜像。**

理由：

1. **生命周期**。工具调用跑在主进程 `streamText` 循环里（`chat-service.ts:101`），Monaco model 活在渲染进程。让工具反向 IPC 进渲染层读行，等于把 AI 链路的正确性押在「窗口开着、可见、只有一个、没切路由」上。用户切项目页、关窗后台生成、将来开第二个窗口，全都会断。
2. **可测性**。主进程纯 TS 的 VFS 能直接进 vitest（项目已有 `file-stream-parser.test.ts` 的先例）；跨进程的就不能。
3. **收益归属要说清**。`getLineContent` / `applyEdits` / `findMatches` 这些 model API，用 `string[]` 在主进程包一层约一百行代码就等价了 —— Monaco 对「工具读写行」本身**没有独占价值**。

Monaco 真正值钱的地方在**视图侧**，而且恰恰是工具化之后才显现：全文重写时代码区是「打字机」，换成 patch 后没东西可打字了 —— 这时靠 `model.applyEdits()` 就地打进改动、decoration 闪一下改动行、`revealLineInCenter` 滚过去，观感比现在更好。**这才是引 Monaco 的理由。**

数据流：

```
主进程                                    渲染进程
┌────────────────────────────┐
│ SessionVfs（回合内真值）    │
│  seed ← latestArtifact      │
│  read / edit / write / rm   │  ─ file-patch 事件 ─▶  monaco models（镜像）
│  ↓ 回合结束 diff            │                        applyEdits + 改动行高亮
│ createArtifactVersion       │
│  (writes / deletes)         │  ─ done(artifactId) ─▶  artifact store 切到新版本
└────────────────────────────┘
```

## 3. 阶段一：布局

`src/renderer/src/pages/project/index.vue:51`

```diff
-      <a-splitter-panel :default-size="440" :min="340" :max="720" class="chat-pane">
+      <a-splitter-panel :default-size="360" :min="300" :max="720" class="chat-pane">
```

右侧 `workspace-pane` 是 flex 剩余，自动变宽，`:min="480"` 不用动。

`WorkspacePane.vue:96` 的 `.code-layout` 换成内层 `a-splitter`，让文件树宽度也可拖：

```vue
<a-splitter class="code-layout">
  <a-splitter-panel :default-size="200" :min="140" :max="360">
    <FileTree />
  </a-splitter-panel>
  <a-splitter-panel :min="320">
    <CodeViewer />
  </a-splitter-panel>
</a-splitter>
```

宽度建议持久化到 localStorage（`@vueuse/core` 的 `useStorage` 已在自动导入白名单里）。

## 4. 阶段二：Monaco + Shiki 只读代码区

### 4.1 依赖

```bash
pnpm add monaco-editor shiki @shikijs/monaco @shikijs/engine-javascript
```

渲染层打包预计 +5～8MB。Electron 桌面端可接受。

### 4.2 三个必须提前处理的坑

**① CSP 会挡住 Shiki 的 wasm。** `src/renderer/index.html:10` 是 `script-src 'self'`，Chromium 在指定了 script-src 的情况下实例化 WebAssembly 需要 `'wasm-unsafe-eval'`。

两条路，**推荐第二条**：

- 放宽 CSP 到 `script-src 'self' 'wasm-unsafe-eval'`；
- **或者用 `@shikijs/engine-javascript` 纯 JS 正则引擎**，完全不碰 wasm。只读高亮场景够用，还省一个打包和 file:// 加载的麻烦，CSP 一个字不用动。

**② worker 只装 `editor.worker`。** 只读查看器不需要语言服务，别引 `ts.worker` / `html.worker` 那一套（体积大且在 file:// 下要额外折腾）。高亮全部交给 Shiki，Monaco 只当渲染器。

```ts
// src/renderer/src/monaco/setup.ts
import * as monaco from 'monaco-editor'
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker'

self.MonacoEnvironment = { getWorker: () => new EditorWorker() }
```

若打包后 worker 加载异常，在 `electron.vite.config.mts` 的 `renderer` 段加 `worker: { format: 'es' }`。

**③ 主题必须跟 antdv-next 的 token 走。** 各组件都用 `theme.useToken()`，Monaco 需要在亮/暗切换时 `monaco.editor.setTheme()`。Shiki 侧一次注册双主题。

### 4.3 高亮初始化

```ts
// src/renderer/src/monaco/highlighter.ts
import { createHighlighterCore } from 'shiki/core'
import { createJavaScriptRegexEngine } from '@shikijs/engine-javascript'
import { shikiToMonaco } from '@shikijs/monaco'
import * as monaco from 'monaco-editor'

const LANGS = ['html', 'css', 'javascript', 'typescript', 'jsx', 'tsx', 'vue', 'json', 'markdown']

let ready: Promise<void> | null = null

export function ensureHighlighter(): Promise<void> {
  ready ??= (async () => {
    const highlighter = await createHighlighterCore({
      themes: [
        import('shiki/themes/vitesse-light.mjs'),
        import('shiki/themes/vitesse-dark.mjs')
      ],
      langs: LANGS.map((id) => import(`shiki/langs/${id}.mjs`)),
      engine: createJavaScriptRegexEngine()
    })
    // shikiToMonaco 只对已注册的 language id 生效，必须先 register
    for (const id of LANGS) monaco.languages.register({ id })
    shikiToMonaco(highlighter, monaco)
  })()
  return ready
}
```

`vue` 不是 Monaco 内置语言，但 Shiki 有对应 TextMate 语法，`register` 之后就能高亮 —— 这也是选 Shiki 而不是 Monaco 自带 Monarch 的直接原因。

### 4.4 model 池（渲染侧镜像 VFS）

一个文件一个 `ITextModel`，切文件只换 `editor.setModel()`，不重建编辑器 —— 这样滚动位置、折叠状态、以及**增量 patch 的历史**都能保住。

```ts
// src/renderer/src/monaco/vfs.ts
const models = new Map<string, monaco.editor.ITextModel>()

const EXT_LANG: Record<string, string> = {
  html: 'html', css: 'css', js: 'javascript', mjs: 'javascript',
  ts: 'typescript', jsx: 'jsx', tsx: 'tsx', vue: 'vue',
  json: 'json', md: 'markdown'
}

export function getModel(path: string, content: string): monaco.editor.ITextModel {
  const uri = monaco.Uri.parse(`vfs:///${path}`)
  let model = models.get(path)
  if (!model) {
    const lang = EXT_LANG[path.split('.').pop() ?? ''] ?? 'plaintext'
    model = monaco.editor.createModel(content, lang, uri)
    models.set(path, model)
  }
  return model
}

/** 全量替换：走 pushEditOperations 而不是 setValue，保住 undo 栈与滚动位置 */
export function setContent(path: string, content: string): void {
  const model = models.get(path)
  if (!model) return
  model.pushEditOperations([], [{ range: model.getFullModelRange(), text: content }], () => null)
}

/** 局部 patch：定位 oldText 的位置后就地 applyEdits，并闪一下改动行 */
export function applyPatch(path: string, oldText: string, newText: string): void {
  const model = models.get(path)
  if (!model) return
  const hit = model.findMatches(oldText, false, false, true, null, false, 1)[0]
  if (!hit) return setContent(path, newText) // 兜底：定位失败退回全量
  model.pushEditOperations([], [{ range: hit.range, text: newText }], () => null)
}

export function disposeAll(): void {
  for (const m of models.values()) m.dispose()
  models.clear()
}
```

切换 artifact 版本时 `disposeAll()` 重建，避免旧版本的 model 串味。

### 4.5 CodeViewer 改造

`CodeViewer.vue` 整体替换 `pre` 为 Monaco 容器，关键选项：

```ts
monaco.editor.create(el, {
  readOnly: true,
  domReadOnly: true,
  automaticLayout: true,      // 跟随 splitter 拖拽重排
  minimap: { enabled: false },
  scrollBeyondLastLine: false,
  fontSize: 12,
  lineHeight: 20,
  renderLineHighlight: 'none',
  contextmenu: false,
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'
})
```

- **流式期间（旧协议）**：`file-delta` 累积后 `setContent()`，配合 `revealLine(model.getLineCount())` 保留现有「贴底打字机」观感（对应现在 `CodeViewer.vue:14` 的 watch）。
- **工具期间（新协议）**：收到 `file-patch` → `applyPatch()` → `revealLineInCenter()` → 加一条 2s 后自动清除的 decoration 高亮改动行。
- 组件 `onBeforeUnmount` 里 `editor.dispose()`，model 由 vfs 池统一管。

## 5. 阶段三：主进程 SessionVfs + 工具链

### 5.1 SessionVfs

```ts
// src/main/ai/session-vfs.ts
export interface VfsPatch {
  path: string
  oldText: string      // 空串表示新建
  newText: string
}

export class SessionVfs {
  private files: Map<string, string>
  private touched = new Set<string>()
  private removed = new Set<string>()

  constructor(seed: ArtifactFile[]) {
    this.files = new Map(seed.map((f) => [f.path, f.content]))
  }

  list(): string[]
  read(path: string, offset?: number, limit?: number): string   // 带行号返回
  write(path: string, content: string): VfsPatch
  edit(path: string, oldText: string, newText: string, replaceAll?: boolean): VfsPatch
  remove(path: string): void

  get hasChanges(): boolean
  /** 回合结束交给 createArtifactVersion，签名与现有 parser.files / parser.deleted 一致 */
  get writes(): Map<string, string>
  get deletes(): Set<string>
}
```

`writes` / `deletes` 的形状刻意与 `FileStreamParser` 对齐，**`createArtifactVersion` 与数据库 schema 一个字都不用改**。

路径校验沿用现协议规则：相对路径、不含 `..`、不以 `/` 开头（`protocol.ts` 规则 4），在 VFS 入口统一拦截。

### 5.2 工具定义

**用锚点字符串定位，不用行号定位。** 行号在连续编辑中会漂移 —— 模型基于第 2 步读到的行号做第 5 步的编辑必然错位。行号**只用于读和描述位置**，写一律靠唯一字符串匹配。

```ts
// src/main/ai/tools.ts
import { tool } from 'ai'
import { z } from 'zod'

export function buildFileTools(vfs: SessionVfs, emitPatch: (p: VfsPatch) => void) {
  return {
    list_files: tool({
      description: '列出当前设计稿的所有文件路径',
      inputSchema: z.object({}),
      execute: async () => vfs.list().join('\n')
    }),

    read_file: tool({
      description: '读取文件内容，返回带行号的文本。行号仅供定位参考，不要用于编辑。',
      inputSchema: z.object({
        path: z.string(),
        offset: z.number().int().min(1).optional().describe('起始行号，从 1 开始'),
        limit: z.number().int().min(1).optional().describe('读取行数')
      }),
      execute: async ({ path, offset, limit }) => vfs.read(path, offset, limit)
    }),

    edit_file: tool({
      description:
        '局部替换文件内容。old_string 必须与文件中的一段完整原文逐字符一致，' +
        '且在文件中唯一；包含足够的上下文行来保证唯一性。这是修改已有文件的首选方式。',
      inputSchema: z.object({
        path: z.string(),
        old_string: z.string(),
        new_string: z.string(),
        replace_all: z.boolean().optional()
      }),
      execute: async ({ path, old_string, new_string, replace_all }) => {
        const patch = vfs.edit(path, old_string, new_string, replace_all)
        emitPatch(patch)
        return `已编辑 ${path}`
      }
    }),

    write_file: tool({
      description: '整份写入文件（新建文件，或改动幅度过大时的重写）。已有文件优先用 edit_file。',
      inputSchema: z.object({ path: z.string(), content: z.string() }),
      execute: async ({ path, content }) => {
        emitPatch(vfs.write(path, content))
        return `已写入 ${path}`
      }
    }),

    delete_file: tool({
      description: '删除文件',
      inputSchema: z.object({ path: z.string() }),
      execute: async ({ path }) => {
        vfs.remove(path)
        return `已删除 ${path}`
      }
    })
  }
}
```

**`edit_file` 的错误必须说人话**，模型靠它自我纠正：

| 情况 | 返回给模型的错误 |
| --- | --- |
| `old_string` 未命中 | `未找到匹配内容。请先 read_file 确认原文（注意缩进与空行），old_string 需逐字符一致。` |
| 命中多处 | `匹配到 N 处。请扩大 old_string 包含更多上下文行，或传 replace_all: true。` |
| 文件不存在 | `文件不存在。新建文件请用 write_file。` |
| `old_string === new_string` | `新旧内容相同，无需编辑。` |

这些错误**返回为工具结果、不抛异常** —— 抛异常会中断 `streamText` 循环，返回错误文本则让模型看到并重试。

### 5.3 chat-service 分流

`chat-service.ts` 按 `model.abilities.includes('tools')` 分两条路，**共用同一个落库出口**：

```ts
const useTools = model.abilities.includes('tools')
const vfs = new SessionVfs(currentFiles)

const result = streamText({
  model: getLanguageModel(input.providerId, model.modelId),
  system: buildSystemPrompt(project, currentFiles, { mode: useTools ? 'tools' : 'markers' }),
  messages: [...history, { role: 'user', content: input.text }],
  abortSignal: abort.signal,
  ...(useTools
    ? { tools: buildFileTools(vfs, (p) => emit({ streamId, type: 'file-patch', ...p })),
        stopWhen: stepCountIs(24) }
    : {})
})
```

- **tools 路**：`textStream` 里的文本直接当解说 emit（不再过 `FileStreamParser`）；文件变更由工具 `execute` 里的 `emitPatch` 推给渲染层。
- **markers 路**：完全保持现状，`FileStreamParser` 解析完把 `parser.files / parser.deleted` **灌进同一个 `SessionVfs`**。

`finalize()` 只认 VFS 一个来源：

```ts
if (status !== 'error' && vfs.hasChanges) {
  createArtifactVersion({ ..., writes: vfs.writes, deletes: vfs.deletes, summary })
}
```

中止（`abortChat`）语义不变：已执行的工具调用已经落在 VFS 里，照常成版本（对应 `chat-service.ts:121` 的注释）。

`stopWhen: stepCountIs(24)` 是防跑飞的上限；触顶时按 `aborted` 处理并在解说里说明。

### 5.4 system prompt 改造

tools 模式下，`buildSystemPrompt` 的 `renderCurrentFiles`（`prompts/index.ts:29`）**只注入文件树，不注入全文**，改由模型按需 `read_file`。这是 VFS 的另一半收益 —— 输入 token 同样降一个数量级。

```
## 当前设计稿

文件树：
- index.html
- css/style.css

用 read_file 读取需要修改的文件。修改已有文件用 edit_file（局部替换），
新建文件用 write_file。不要为了改一处而重写整份文件。
```

`FILE_PROTOCOL` 段在 tools 模式下整段不注入 —— 两套协议同时出现会让模型混用。

**待验证**：小上下文模型（<32k）在「不给全文、逼它 read_file」时，可能多绕一两轮。若实测明显变差，退化策略是文件总量小于某阈值（如 8k tokens）时仍直接全文注入，超过才切按需读。

### 5.5 预览的取舍

预览走 `preview://artifact/<id>/` 从 DB 直出已落库版本（`PreviewPane.vue:17`）。工具编辑期间的工作副本不在库里。

- **一期（推荐）**：回合结束才刷新预览，与现状一致，零改动。
- 二期可选：引入 draft 版本让预览跟着每次 patch 热更 —— 但要动 preview 协议和版本表语义，收益不足以放进第一版。

## 6. 新增的流式事件

`src/shared/types.ts:111` 的 `ChatStreamEvent` 加一个成员：

```ts
| { type: 'file-patch'; path: string; oldText: string; newText: string }
```

`artifact` store（`stores/artifact.ts:66` 的 `applyStreamEvent`）加对应分支：更新 `pending` 里的内容，并把 patch 转交给 Monaco vfs 的 `applyPatch()`。

现有 `file-start / file-delta / file-end / file-delete` **全部保留** —— markers 路还在用。

## 7. 风险清单

| 风险 | 应对 |
| --- | --- |
| Shiki wasm 撞 CSP | 用 JS 正则引擎绕开，不动 CSP |
| Monaco worker 在打包后 file:// 下加载失败 | 只引 `editor.worker`；必要时 `worker: { format: 'es' }` |
| 模型 `edit_file` 反复匹配失败空转 | 错误文案给足指引 + `stepCountIs` 上限 + 连续 3 次失败时提示改用 `write_file` |
| 弱模型被工具拖垮 | `abilities.tools` 门控，长尾模型继续走 markers 协议 |
| 按需 read_file 让小模型多绕轮次 | §5.4 的阈值退化策略 |
| 渲染层 model 池泄漏 | 切版本 / 卸载时 `disposeAll()` |
| 打包体积 +5～8MB | Electron 桌面端可接受，不做处理 |

## 8. 分期与验收

| 阶段 | 内容 | 验收 | 估时 |
| --- | --- | --- | --- |
| 一 | 布局：左栏收窄、代码区内层 splitter | 拖拽正常、宽度持久化 | 0.5h |
| 二 | Monaco + Shiki 只读视图 | 亮暗主题跟随、vue/html/css 高亮正确、流式打字机观感不退化 | 1d |
| 三 | SessionVfs + 工具链 + 双协议分流 | 改一处颜色的输出 token 降一个数量级；版本落库与旧协议结果一致；中止后半成品照常成版本 | 2～3d |

每阶段可独立上线。

**必须有的单测**（对齐 `file-stream-parser.test.ts` 的风格）：

- `SessionVfs.edit` 的未命中 / 多处命中 / 唯一命中三种路径
- 路径校验拦截 `..`、绝对路径
- markers 路与 tools 路灌进 VFS 后产出的 `writes/deletes` 等价

## 9. 涉及文件

**新增**

```
src/main/ai/session-vfs.ts            SessionVfs + 单测
src/main/ai/tools.ts                  工具定义
src/renderer/src/monaco/setup.ts      worker 环境
src/renderer/src/monaco/highlighter.ts Shiki 接入
src/renderer/src/monaco/vfs.ts        model 池 + applyPatch
```

**修改**

```
src/renderer/src/pages/project/index.vue              布局宽度
src/renderer/src/pages/project/components/WorkspacePane.vue  内层 splitter
src/renderer/src/pages/project/components/CodeViewer.vue     pre → Monaco
src/renderer/src/stores/artifact.ts                   file-patch 分支
src/shared/types.ts                                   ChatStreamEvent 新成员
src/main/ai/chat-service.ts                           双协议分流 + VFS 落库
src/main/ai/prompts/index.ts                          tools 模式下只注入文件树
src/renderer/index.html                               （仅当选 wasm 方案）CSP
electron.vite.config.mts                              （仅当 worker 加载异常）
```

**不改**：`src/main/db/schema.ts`、`src/main/db/repo/artifact.ts`、`src/main/preview/*`。

## 10. 实现记录：与计划的偏差

按上面的方案落地时，有九处跟计划写的不一样，都是实现中发现的硬约束。

**① Monaco 入口不能用 `'monaco-editor'` 根路径。** 根入口等于 `editor.main`，会把几十种内置
Monarch 语言和 ts / css / html / json 语言服务一起拉进来。这些语言在建 model 时会按 label
去要各自的 worker，而我们只提供 `editor.worker` —— 协议对不上直接报错。改成只取内核
`monaco-editor/editor/editor.api`，再单独引 find / folding / bracketMatching 三个 contrib
（`editor.api` 本身连查找框都没有）。打包从 7.0MB 降到 5.7MB。

**② worker 路径是 `monaco-editor/editor/editor.worker?worker`。** monaco 0.56 的 exports 映射是
`'./*' → './esm/vs/*.js'`，计划里写的 `monaco-editor/esm/vs/editor/editor.worker` 会被解析成
`esm/vs/esm/vs/...`，Rolldown 直接报无法解析。同理 CSS 子路径根本引不进来（会被补成 `.css.js`），
codicon 样式靠 contrib 自己带进来。

**③ Shiki 的 JS 正则引擎要开 `forgiving: true`。** 个别 Oniguruma 语法 JS 正则表达不了，
不开就整份语法抛错。已实测 vue / html / css / tsx 四种语法在纯 JS 引擎下着色正常，
**CSP 一个字没动**。

**④ patch 必须在 store 更新自己那份内容之前打进 Monaco。** 计划里 §6 让 artifact store
"更新 pending 并把 patch 转交给 vfs"，但如果先更新 store，Vue 的 watch 会先把新内容同步进
model，等 patch 到达时 `oldText` 锚点已经不存在了，只能退回全量替换 —— 滚动位置全丢，增量编辑
的意义也就没了。改成 store 暴露 `setPatchListener()`，CodeViewer 挂载时注册，store 在改自己的
副本**之前**同步回调。

**⑤ `displayFiles` 改成「当前版本打底 + pending 覆盖」。** 原来流式期间只显示 pending。
工具协议下一轮可能只动一个文件，只显示 pending 会让整棵文件树塌成一个节点。

**⑥ `write_file` 的 patch 用空 `oldText` 表示整份替换。** 计划里空串只表示"新建"，实现中
扩展成"新建或全文重写"—— 全文重写没必要为了走锚点匹配再把旧全文传一遍过 IPC。

**⑦ `getModel` 会自愈。** 计划里切版本 `disposeAll()` 重建。实现改成：同项目内切版本不清池，
`getModel(path, content)` 发现 model 内容与真值对不上就地校正（滚动位置还能保住）；只有换项目
才整池清掉（不同项目撞 `index.html` 这种同名路径会串味），入口是 `setScope(projectId)`。

**⑧ `SessionVfs.ingest` 丢弃非法路径而不是抛。** markers 路的路径来自模型自由书写的标记，
一个 `../x` 不该让整回合的产出都落不了库。工具路仍然抛 `VfsError`，因为那是要给模型看的指引。

**⑨ AI SDK v7 的 `tool()` 有两个类型推断坑**，踩中的表现都是 `inputSchema` 报
"not assignable to `FlexibleSchema<never>`"：
- 不能直接 `return { ... }` 给一个标了 `ToolSet` 返回类型的函数 —— `ToolSet` 会反向上下文推断，
  把每个 tool 的 INPUT 泛型压成 `never`。先建 const 再 return。
- schema 带可选字段时，`execute` 的参数**不能解构** —— 解构模式会参与 INPUT 推断并同样压成
  `never`。`read_file` / `edit_file` 因此用 `input.path` 而不是 `{ path }`。

**未实现**：§5.4 的"小上下文模型阈值退化"。tools 模式当前一律只注入文件树，等实测到有模型
明显多绕轮次再加。

**验收状态**：`typecheck` / `eslint` / `electron-vite build` 全绿，`SessionVfs` 单测 24 条通过
（含两条协议灌进 VFS 后 `writes/deletes` 等价）。三条主链路（工具编辑、markers 全文流式、
亮暗主题跟随）需要在应用里手工过一遍。

## 11. 工具集扩充：照 VS Code agent 的分工重做

§5.2 那五个工具（list/read/edit/write/delete）够用但不够省。对着 VS Code 的
[chat tools reference](https://code.visualstudio.com/docs/agents/reference/copilot-vscode-features)
把分工补齐到 11 个。

### 11.1 从 VS Code 抄来的三条机制

**① 读一律有上限，且"没读到的部分"要交代清楚。** VS Code 的 `read/readFile` 要求给行区间，
文件更大时**返回区间 + 其余部分的大纲**而不是全文（[vscode#282483](https://github.com/microsoft/vscode/issues/282483)）；
另有 `MAX_LINE_LENGTH` 截断超长行。我们照做：`MAX_READ_LINES = 400`、`MAX_LINE_CHARS = 800`，
超出的部分自动附结构大纲。设计稿里压过的 CSS 一行能有几万字符，不截断就是一次性烧光上下文。

**② 先搜再读。** `search/textSearch` + `search/fileSearch` 让 agent 靠搜索定位，大多数改动
根本不必打开文件。我们的 `search_files` 直接返回 `路径:行:列` 和命中行，可带上下文行。

**③ 让模型能自查改动。** `search/changes` 对应我们的 `diff_changes` —— 收尾前看 diff 比重读
一遍文件便宜得多。

还有一条 VS Code 文档里没写但同样要紧的：**工具循环每多走一步，整个对话历史就要重发一遍**。
所以步数本身就是 token，而且是乘在上下文长度上的。这是 `multi_edit_file` / `apply_patch`
的真正价值，不只是"少敲几次"。

### 11.2 最终工具集

| 工具 | 对应 VS Code | 作用 |
| --- | --- | --- |
| `list_files(glob?)` | `search/listDirectory` | 列文件，**带行数**，支持 glob |
| `outline_file(path)` | —（VS Code 靠 LSP outline） | 结构大纲：html 区块与 id、css 选择器、js 顶层声明 |
| `read_file(path, start_line?, end_line?)` | `read/readFile` | 行区间读；超限截断并补区间外大纲 |
| `get_range(path, 行, 列…)` | — | **按行列取原文，不带行号**，取出来直接当 `old_string` |
| `search_files(query, is_regex?, glob?, context_lines?)` | `search/textSearch` | 全文搜索，返回行列与上下文 |
| `edit_file` | `replace_string_in_file` | 改一处 |
| `multi_edit_file(path, edits[])` | `multi_replace_string_in_file` | 同文件多处，全成或全不成 |
| `apply_patch(patch)` | `apply_patch` | V4A 补丁，跨文件一次改完，原子 |
| `write_file` / `delete_file` | `edit/createFile` | 整份写 / 删 |
| `diff_changes()` | `search/changes` | 本回合的 unified diff，自查用 |

`get_range` 是自己加的，解决 `edit_file` 最常见的失败模式：模型照着 `read_file` 的带行号输出
手抄锚点，缩进或空白抄错就匹配不上。搜到行列之后直接把原文切出来，抄写这一步就没了。

`outline_file` 也不在 VS Code 的清单里 —— 它那边靠 LSP 拿 document symbols，我们没有语言服务，
用几十行启发式正则顶上。大纲不准的后果只是模型多读一段，不会出错，不值得引一套 parser。

### 11.3 实现上的几个决定

- **补丁用 V4A 而不是标准 unified diff。** V4A 不带行号，靠上下文行定位，跟 `edit_file` 的锚点
  是同一套思路；标准 diff 的行号在连续编辑中必然漂移。落到实现上每个 hunk 就是一次
  `edit(before, after)`，`patch-format.ts` 只负责解析。
- **`SessionVfs.transact()`。** `apply_patch` 改到第三个文件才发现锚点对不上时，前两个文件不能
  留在半成品状态。事务包住文件表与改动集，patch 事件也攒到事务成功才发 —— 否则渲染层已经把
  回滚掉的改动画上去了。
- **所有工具结果有 12000 字符硬上限。** 结果会随每一步重发，放任下去等于持续漏 token。
- **`search` 每行只报第一处命中。** VS Code 的 `grep_search` 有过重复返回的
  [bug](https://github.com/microsoft/vscode/issues/261130)，一行一条是更干净的契约。
- **大纲的正则要挡掉 JS 控制流。** `if (x) {` 会同时被"CSS 选择器"和"方法定义"两条规则命中，
  .vue 文件的脚本段会往大纲里灌噪音，两处都加了关键字负向前瞻。

### 11.4 prompt 侧

tools 模式的协议段改成显式的工作流（定位 → 修改 → 收尾），并把"每多一轮工具调用整个对话都要
重发一遍，能合并就合并"直接写给模型看。文件树也带上行数，模型看一眼就知道哪些文件大到不该
整份读，省掉一次"读了才发现太大"的往返。

### 11.5 补全成完整环境（15 个工具）

11.2 那版还只是"能改文件"，不是一套完整的 VFS 环境。又补了四个：

- **`move_file` / `copy_file`**：重命名原本要 `write_file`（整份内容）+ `delete_file`，
  几百行的文件白吐几千 token，而这个操作根本不需要内容参与。
- **`revert_file`**：改坏了的逃生口。没有它只能重写整份，而"重写一份自己刚弄坏的文件"
  恰恰最容易越描越黑。本回合新建的文件撤销后直接消失。
- **`check_syntax`**：对应 VS Code 的 `read/problems`。没有它，括号少一个要等用户看预览才
  发现，而那时版本已经落库了。设计上宁可漏报不可误报——详见 vfs-design.md §4.7。

**验收**：单测 128 条通过（`session-vfs.test.ts` 70 + `tools.test.ts` 28 +
`text-syntax.test.ts` 21 + `file-stream-parser.test.ts` 9）。
