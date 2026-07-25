# 设计稿 VFS 环境 · 全套设计

> 状态：已实现 · 2026-07-24
> 代码：`src/main/ai/{session-vfs,tools,patch-format,text-outline,text-diff,text-syntax}.ts`
> 阶段落地过程与踩坑记录见 [monaco-vfs-tools.md](./monaco-vfs-tools.md)

这是一套给 AI 用的虚拟文件系统。它不是磁盘的抽象——**磁盘上根本没有这些文件**。设计稿以
行的形式存在 SQLite 里，VFS 是一个回合内把它们摊开成"可读可改的文件树"的内存层，回合结束
再合并成一个新版本落库。

所有设计取舍都围绕一个约束：**这套环境的唯一使用者是语言模型**。模型不会 `ls` 之后翻页，
不会记得三步之前的行号，看到的每一个字节都要花钱，而且每多调一次工具，整个对话历史就要
重发一遍。下面的每一条都是从这个约束推出来的。

---

## 1. 分层

```
┌─ 渲染进程 ─────────────────┐        ┌─ 主进程 ────────────────────────┐
│ Monaco model 池（镜像）     │        │ SessionVfs（回合内真值）         │
│  getModel / applyPatch     │◀─ IPC ─│   files: Map<path, content>     │
│  内容对不上就自愈           │file-   │   original: 回合开始时的快照      │
│                            │patch   │   touched / removed             │
│ artifact store             │        │        ▲                        │
│  pending / pendingDeletes  │        │        │ 15 个工具               │
└────────────────────────────┘        │   buildFileTools(vfs, sink)     │
                                      │        ▲                        │
                                      │        │ streamText 工具循环      │
                                      └────────┼────────────────────────┘
                                               │ 回合结束
                                      ┌────────▼────────────────────────┐
                                      │ createArtifactVersion           │
                                      │  writes / deletes → 新版本行     │
                                      └─────────────────────────────────┘
```

**真值在主进程，不在 Monaco。** 工具调用跑在主进程的 `streamText` 循环里，Monaco model 活在
渲染进程。让工具反向 IPC 进渲染层读写，等于把 AI 链路的正确性押在"窗口开着、可见、只有一个、
没切路由"上——切项目页、关窗后台生成、开第二个窗口全都会断。而且纯 TS 的 VFS 能直接进
vitest，跨进程的不能。

Monaco 只是镜像，靠 `file-patch` 事件跟随；即使镜像掉队，`getModel(path, content)` 会按真值
自愈。**镜像出错不影响落库结果**——这是分层的意义。

## 2. 数据模型与不变量

```ts
class SessionVfs {
  private files: Map<string, string>      // 当前状态
  private original: Map<string, string>   // 回合开始时的快照
  private touched: Set<string>            // 本回合新建或改过
  private removed: Set<string>            // 本回合删掉
}
```

四条不变量，所有写操作都必须维持：

1. **`touched` 与 `removed` 互斥。** 写一个删过的文件 → 从 `removed` 移出、进 `touched`；
   删一个写过的文件 → 反之。任何时刻一个路径只在一边。
2. **`touched` 里的路径一定在 `files` 里。** `writes` getter 直接 `files.get(path)!`。
3. **`original` 只读。** 它是 diff 和 `revert` 的基准，从构造之后再不改动。
4. **`writes` / `deletes` 的形状与 `FileStreamParser.files` / `.deleted` 完全一致。**
   两条协议（工具 / `<antdFile>` 标记）共用同一个落库出口，`createArtifactVersion` 和数据库
   schema 一个字都不用改。

**路径规则**（`assertPath`）：相对路径、不含 `..`、不以 `/` 或盘符开头，反斜杠归一成正斜杠。
目录是**隐含的**——`files` 是平坦的 path→content 映射，没有目录实体，所以也没有 `mkdir`：
写 `css/theme.css` 目录就存在了，删光该前缀的文件目录就没了。这与设计稿导出时按 path 建目录
的行为一致。

## 3. 工具面（15 个）

分工照 VS Code agent 那套（`read/readFile`、`search/textSearch`、`search/fileSearch`、
`edit/editFiles`、`search/changes`、`read/problems`）裁剪到设计稿场景。

### 3.1 浏览与定位

| 工具 | 参数 | 说明 |
| --- | --- | --- |
| `list_files` | `glob?` | 列文件，**带行数**。模型据此判断该不该整份读，而不是读了才知道太大 |
| `outline_file` | `path` | 结构大纲：html 区块与 id、css 选择器、js 顶层声明，带行号 |
| `search_files` | `query, is_regex?, glob?, context_lines?, case_sensitive?, max_results?` | 全文搜索，返回 `路径:行:列` 与命中行。每行只报第一处 |

### 3.2 读

| 工具 | 参数 | 说明 |
| --- | --- | --- |
| `read_file` | `path, start_line?, end_line?` | 行区间闭区间读，带行号。超限截断并补区间外大纲 |
| `get_range` | `path, start_line, end_line?, start_column?, end_column?` | **按行列取原文，不带行号**，取出来直接当 `old_string` |

### 3.3 写

| 工具 | 参数 | 说明 |
| --- | --- | --- |
| `write_file` | `path, content` | **新建文件**，或改动幅度大到重写更划算时 |
| `edit_file` | `path, old_string, new_string, replace_all?` | 改一处 |
| `multi_edit_file` | `path, edits[]` | 同文件多处，顺序施加，全成或全不成 |
| `apply_patch` | `patch` | V4A 补丁，跨文件一次改完，原子 |
| `move_file` | `from, to` | 重命名 / 移动，**内容不参与** |
| `copy_file` | `from, to` | 复制，做变体时用 |
| `delete_file` | `path` | 删除 |

### 3.4 自查与撤销

| 工具 | 参数 | 说明 |
| --- | --- | --- |
| `check_syntax` | `path?` | 括号 / 标签配对、JSON 可解析性。缺省检查本回合动过的全部文件 |
| `diff_changes` | — | 本回合的 unified diff |
| `revert_file` | `path` | 退回本回合开始时的样子 |

### 3.5 为什么是这 15 个

**每个工具都要能回答"没有它，模型会多花多少 token"。**

- `search_files` / `outline_file`：没有它们，定位只能整份读文件。一个 400 行的 `index.html`
  约 5k token，改一处颜色就要付一次。
- `get_range`：没有它，模型只能照着 `read_file` 的带行号输出手抄锚点，缩进或空白抄错就匹配
  不上，一次失败就是一轮往返。这是 `edit_file` 最常见的失败模式。
- `multi_edit_file` / `apply_patch`：**每多一轮工具调用，整个对话历史要重发一遍**。改 5 处
  分 5 次调用，付的不是 5 份编辑成本，是 5 份"当前全部上下文"的成本。
- `move_file` / `copy_file`：没有它们，重命名 = `write_file`（整份内容）+ `delete_file`。
  一个几百行的文件白吐几千 token，而这个操作根本不需要内容参与。
- `check_syntax`：没有它，括号少一个要等用户看预览才发现，而那时版本已经落库了。
- `revert_file`：没有它，改坏了只能重写整份——而"重写一份自己刚弄坏的文件"恰恰最容易越描越黑。
- `diff_changes`：没有它，自查只能重读文件。

**刻意不做的：**

- **`create_directory`**：目录是隐含的，见 §2。
- **`run_command` / 终端**：设计稿是静态产物，没有构建步骤可跑。
- **`semantic_search` / `list_code_usages`**：VS Code 靠 embedding 和 LSP，我们的"代码库"是
  几个文件，`search_files` 足够；引一套语言服务的成本远超收益。
- **二进制 / 图片写入**：VFS 是纯文本的。图片走 `storage` 服务和 `asset://` 协议，模型只能
  在 HTML 里引用，不能生成。
- **用户手动编辑**：Monaco 是 `readOnly`。真值在主进程，双向编辑要引入冲突合并，不值得。

## 4. 核心设计取舍

### 4.1 锚点定位，不用行号

**行号只用于读和描述位置，写一律靠唯一字符串匹配。**

行号在连续编辑中会漂移——模型基于第 2 步读到的行号做第 5 步的编辑必然错位，而且错得静悄悄
（改到了别的地方，不报错）。所有写操作的定位参数都是原文锚点：

- `edit_file` / `multi_edit_file`：`old_string` 必须逐字符一致且唯一
- `apply_patch`：V4A 格式**不带行号**，靠上下文行定位

选 V4A 而不是标准 unified diff 正是这个原因：标准 diff 的 `@@ -12,7 +12,8 @@` 头带行号，
模型是照着几步之前读到的内容写补丁的，行号必然对不上。V4A 每个 hunk 落到实现上就是一次
`edit(before, after)`，与 `edit_file` 同一套机制。

`get_range` 是这条原则的配套：搜到行列之后把原文精确切出来，抄写这一步就没了。

### 4.2 唯一性检查是特性，不是限制

`edit_file` 命中多处时**拒绝执行**并报出命中数，而不是默认改第一处。默认改第一处会让模型
以为改完了，实际只改了一半——这种错误要到用户看预览才暴露。要么扩大锚点，要么显式
`replace_all: true`，让模型自己表态。

### 4.3 全成或全不成

两级原子性：

- `multiEdit`：在一个本地字符串副本上顺序施加，全部成功才写回 `files`。失败时报出**是第几处**。
- `transact()`：包住整个 `files` / `touched` / `removed` 的快照。`apply_patch` 用它——改到
  第三个文件才发现锚点对不上时，前两个文件不能留在半成品状态，模型自己也说不清改到哪了。

**`patch` 事件也要跟着攒。** `apply_patch` 把事件收进数组，事务成功才统一发出去——否则渲染
层已经把被回滚掉的改动画上去了。

### 4.4 错误是返回值，不是异常

```ts
async function guarded(run: () => string): Promise<string> {
  try {
    return capped(run())
  } catch (err) {
    if (err instanceof VfsError) return `错误:${err.message}`
    throw err   // 非预期错误照常抛，不吞
  }
}
```

抛异常会中断 `streamText` 循环，整回合作废；返回错误文本则让模型看见并自己纠正。所以
`VfsError` 的 message **就是写给模型看的指引**，必须回答"下一步该干什么"：

| 情况 | 返回给模型的话 |
| --- | --- |
| `old_string` 未命中 | 未找到匹配内容。请先 search_files 或 read_file 确认原文（注意缩进与空行）……也可以用 get_range 按行列把原文精确取出来。 |
| 命中多处 | 匹配到 N 处。请扩大 old_string 包含更多上下文行以保证唯一，或传 replace_all: true。 |
| 文件不存在（编辑时） | 文件不存在:X。新建文件请用 write_file。 |
| 文件不存在（读取时） | 文件不存在:X。用 list_files 看现有文件，新建文件用 write_file。 |
| `old_string` 为空 | old_string 不能为空。整份写入请用 write_file。 |
| 新旧相同 | 新旧内容相同，无需编辑。 |
| `move` 目标已存在 | 目标路径 X 已存在。先 delete_file，或换一个名字。 |
| 撤销没改过的文件 | X 本回合没有改动过，无需撤销。 |

注意同一个"文件不存在"在读和写两条路上给的是**不同的下一步**。

### 4.5 token 预算：四道闸

| 闸 | 常量 | 挡住什么 |
| --- | --- | --- |
| 单次读行数 | `MAX_READ_LINES = 400` | 不给区间时整份读大文件 |
| 单行字符数 | `MAX_LINE_CHARS = 800` | 压过的 CSS 一行几万字符，一次烧光上下文 |
| 搜索结果数 | `DEFAULT_SEARCH_RESULTS = 20` / `MAX = 60` | 泛化关键词搜出几百条 |
| 工具结果总长 | `MAX_RESULT_CHARS = 12000` | 任何结果无限膨胀 |

**截断必须说清楚截了什么。** `read_file` 超限时附上"单次最多读 400 行，已截断到第 N 行"
和**区间之外的结构大纲**——模型知道还有什么、在第几行，可以只回来取需要的那一段。悄悄截断
比不截断更糟：模型会以为自己看到了全部。

### 4.6 大纲用启发式，不用 parser

VS Code 靠 LSP 拿 document symbols，我们没有语言服务。`text-outline.ts` 用几十行正则按扩展名
挑"结构行"：

- html/vue：块级标签（`section` / `header` / `form` / `h1-6` …）+ 带 `id` 的任意标签
- css：选择器行与 `@media` 之类的 at 规则
- js/ts/jsx/tsx：顶层声明与方法定义
- md：标题；json：前两层的键

**大纲不准的后果只是模型多读一段，不会出错**，所以不值得引一套 parser。认不出的类型返回空
数组——宁可没有大纲，也不要一份噪音大纲。

两个必须挡掉的误伤：`if (x) {` 会同时被"CSS 选择器"和"方法定义"两条规则命中，.vue 的脚本段
会往大纲里灌噪音，两处都加了 JS 关键字负向前瞻。

### 4.7 自检宁可漏报，不可误报

`check_syntax` 的第一要求是**不误报**——一条假错误会让模型去追一个不存在的问题，白烧好几轮
工具调用，正是我们想省的那部分开销。因此：

- **模板字符串按不透明处理**，`${}` 里的括号不参与配对（可能漏报，不会误报）
- **HTML 里允许省略闭合标签的元素**（`li` / `p` / `td` / `tr` …）根本不进栈——HTML 本来就
  宽容，把 `<li>` 当成必须闭合会造出一大堆假错误
- **认不出的文件类型直接返回空**，不猜
- 字符串、注释、正则字面量都要跳过。`/` 是正则还是除号看前一个有意义的字符（标识符、数字、
  `)`、`]` 之后是除号），这是老掉牙的启发式，在设计稿这种代码里够准

覆盖范围：JSON（`JSON.parse`，精确）、CSS/SCSS/LESS（括号配对）、JS/TS/JSX/TSX（括号配对）、
HTML/Vue（标签配对 + 内嵌 `<script>` 按页面行号报出）。**这不是完整的语法校验**，工具描述
里对模型也是这么说的。

## 5. 事件协议

VFS 的每次改动产出一个 `VfsPatch`，经 `ChatStreamEvent` 送到渲染层：

```ts
interface VfsPatch {
  path: string
  oldText: string    // 锚点原文；空串表示整份替换（新建 / 重写 / 撤销）
  newText: string
  replaceAll?: boolean
}
```

`oldText` 为空串是**整份替换**的信号，渲染层据此走全量分支而不是锚点匹配。`write_file` 用
它，是因为全文重写没必要把旧全文再传一遍过 IPC；`revert_file` 也用它。

删除走 `file-delete` 事件，与旧协议共用。

**时序要求：patch 必须在 store 更新自己那份内容之前同步打进 Monaco。** 晚一步 model 就成了
新内容，`oldText` 锚点再也定位不到，只能退回全量替换——滚动位置全丢，增量编辑的意义也就没了。
这就是 artifact store 暴露 `setPatchListener()` 而不是让 CodeViewer watch 状态的原因。

## 6. 生命周期

```
sendChat
  ├─ latestArtifact(project) → getArtifactFiles → seed
  ├─ new SessionVfs(seed)                    ← original 快照在这里定格
  ├─ streamText({ tools: buildFileTools(vfs, sink), stopWhen: stepCountIs(24) })
  │    └─ 工具循环：每次 execute 直接改 vfs，emit patch
  └─ finalize()
       └─ if (status !== 'error' && vfs.hasChanges)
            createArtifactVersion({ writes: vfs.writes, deletes: vfs.deletes })
```

- **一个回合一个 VFS**，回合结束即弃。没有跨回合状态，下一轮从新的 `latestArtifact` 重新 seed。
- **中止照常落库**：已执行的工具调用已经落在 VFS 里，`abortChat` 走 `finalize('aborted')`，
  半成品也是产物。
- **出错不落库**：`status === 'error'` 时跳过 `createArtifactVersion`。
- **步数上限 24**：触顶按 `aborted` 处理，并在解说里告诉用户"改动已保存，可以继续让我接着改"。
- **弱模型走另一条路**：`model.abilities.includes('tools')` 为假时用 `<antdFile>` 标记协议，
  解析结果经 `vfs.ingest()` 灌进**同一个 VFS**。两条路共用一个落库出口。

## 7. 测试策略

VFS 是纯 TS、不碰 IO，全部可单测。128 条，分三层：

| 文件 | 层次 | 覆盖 |
| --- | --- | --- |
| `session-vfs.test.ts` | VFS 语义 | 编辑的三种路径（未命中 / 多处 / 唯一）、路径校验、读的截断与大纲、行列切片、搜索、glob、事务回滚、改动集、两条协议等价 |
| `tools.test.ts` | 工具契约 | 工具名清单、错误转结果文本而不是抛出、失败时不发 patch、`apply_patch` 跨文件回滚、撤销 |
| `text-syntax.test.ts` | 检查器 | **每组都先测"正常代码零问题"**，再测能否抓到真错误 |

最后一条是刻意的：检查器的主要风险是误报，所以正例比反例更重要。

写这批测试时抓到两个真 bug：单行 CSS 规则 `.hero { color: red; }` 进不了大纲（正则要求 `{`
在行尾），以及 `if (x) {` 被"方法定义"规则误判进大纲。

## 8. 已知局限

| 局限 | 现状 | 何时该处理 |
| --- | --- | --- |
| 大纲是启发式，可能漏结构 | 接受，后果只是多读一段 | 除非实测明显影响定位 |
| `check_syntax` 不查语义（未定义变量、CSS 属性名拼错） | 接受，那是 LSP 的活 | 若产出质量问题集中在此 |
| 模板字符串里的括号不配对 | 接受，宁可漏报 | 不处理 |
| 搜索每行只报第一处 | 刻意的契约 | 不处理 |
| 无跨回合工作副本，预览到回合结束才刷新 | 见 monaco-vfs-tools.md §5.5 | 二期引 draft 版本 |
| 小上下文模型可能因"不给全文"多绕轮次 | 未实测 | 实测变差就加阈值退化 |
| 无二进制 / 图片写入 | 走 storage 服务 | 需要 AI 生成图时 |
