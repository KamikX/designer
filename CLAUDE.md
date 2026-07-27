# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

AI 设计器:Electron 桌面应用,用户用自然语言对话生成多文件设计稿(HTML / Vue3 / React),实时预览、版本管理、可导出。UI 组件库是 antdv-next(不是 ant-design-vue)。代码注释一律中文,写"为什么"而不是"做了什么"——新增代码保持同样的风格与密度。

## 常用命令

```bash
pnpm dev                # 启动开发(electron-vite)
pnpm typecheck          # = typecheck:node(主进程 tsc)+ typecheck:web(vue-tsc)
pnpm lint               # eslint --cache(prettier 走 eslint 插件)
pnpm vitest run                          # 全部测试
pnpm vitest run src/main/skills/scan.test.ts   # 单个测试文件
pnpm db:generate        # schema.ts 改动后生成 SQL 迁移(drizzle-kit)
pnpm build:mac / build:win
```

交付前三件套都要过:`pnpm typecheck && pnpm lint && pnpm vitest run`。

## 架构总览

三进程结构,契约集中在一处:

- `src/shared/types.ts` — **主/渲染进程的唯一契约**。`DesignerApi` 接口定义了整个 `window.api` 面。这里只放类型;不许从 `src/main` import(会把主进程拖进 web 工程,TS6307)。
- `src/main` — 主进程:DB、AI 编排、技能扫描、MCP、预览协议、IPC。
- `src/preload/index.ts` — 手写的 `api` 字面量,每个方法一行 `ipcRenderer.invoke`。因为有 `DesignerApi` 类型标注,漏实现会编译报错。
- `src/renderer` — Vue3 + pinia + antdv-next,页面在 `pages/*/index.vue` + `pages/*/components/`。`ref`/`computed` 等由 unplugin 自动导入,不写 import。

### 新增一个 IPC 方法(固定四步)

1. `src/main/<域>/` 写纯函数(渲染进程传参一律当不可信输入,文件路径必须做越界防护,参考 `skills/files.ts`);
2. `src/main/ipc/index.ts` 的 `registerIpc()` 注册 `域:动作` 通道;
3. `shared/types.ts` 的 `DesignerApi` 加签名;
4. `src/preload/index.ts` 的 `api` 字面量加一行。

坑:IPC 是 structured clone——Vue 响应式代理传不过去(先摊平,见 `stores/chat.ts` 的 `toPlainAnswer`),Buffer 用 ArrayBuffer 传。

### 事实来源分布(改功能前先确认动的是哪个)

| 数据 | 事实来源 | 说明 |
| --- | --- | --- |
| 项目 / 会话 / 消息 / 版本 | SQLite(drizzle,`src/main/db/`) | schema.ts 是唯一事实来源;迁移编进 bundle,**已发布的迁移永远不改** |
| 项目整体视觉方向 | 项目的 `styleBrief` 字段 | 视觉主题的唯一事实来源;`theme.css` 优先按本项目 StyleBrief 生成。首次空项目经用户跳过后可使用独立维度 fallback 完成本轮,但 fallback 不持久化为偏好 |
| 技能 | 文件系统目录 | 扫描顺序即覆盖优先级:`~/.antd-designer/skills` > `~/.agents/skills` > `~/.claude/skills` > 内置 `resources/skills`(见 `skills/scan.ts`)。**没有数据库技能**,身份就是目录名 |
| MCP | `~/.antd-designer/mcp.json` | 密钥不进这个文件,走 `secrets.json`(safeStorage 加密),配置里只留 `${VAR}` 占位 |
| 市场清单 | 设置里配置的远程 `marketUrl` | 没配就是空;拉取失败不抛,状态走 `market:status` |
| 应用配置 | `~/.antd-designer/config.json` | 小而扁的键值;会增长的结构化数据进 SQLite |

历史教训:技能/MCP 曾经 DB 与文件双轨并存,两边互相看不见,最后整体删表收敛。**不要再引入第二事实来源**。

### AI 对话链路(src/main/ai/)

`chat-service.ts` 是流式编排核心,设计会话和纯聊天走同一条链路,靠 `project` 是否存在分流:

- 两种协议:模型有 tools 能力走**工具协议**(文件读写走工具、正文全是解说);长尾模型走 **markers 协议**(`<antdFile>` 全文重写)。两路共用 `SessionVfs` 落库。tools 的 VFS 写闸门只机械锁住“StyleBrief 为空且还没有文件”的首次项目;其他整体风格更新由 prompt 协议要求先成功调用 `set_style_brief` 再写文件。markers 首次空项目的第一轮只能在正文给 2–3 个方向并等待,禁止输出文件;下一轮用户给出方向才先输出 `<antdStyleBrief>`,明确跳过才先输出 `<antdUseStyleFallback />`。收流后先持久化 StyleBrief,再把暂存文件灌入 VFS 并创建 artifact。持久化或 markers 提交失败时不留下新主题或本轮文件;视觉标记本身不进入 VFS、artifact 或正文。
- 工具调用**按次数**封顶(数调用不数步——一步可并行多个调用)。硬上限由用户配置:项目 `settings.toolCallLimit` > 全局 `AppConfig.toolCallLimit`(默认 80),**0 = 不限**(那时只剩累计输入 5× 上下文窗口那条熔断)。软阈值(压缩历史)与禁重读阈值按硬上限的 50% / 75% 派生,不限时退回固定 20 / 30——见 `context-governor.ts` 的 `resolveToolLimits`。
- 技能是**手动勾选制,默认零加载**:纯聊天只有勾选的技能可用(没勾连 L1 目录都没有);设计会话里内置技能(craft-* / target-* / design-seed,含被用户同名覆盖的)自动生效。勾选 = 进目录可激活(渐进披露),**没有全文注入**这条路。
- MCP 按轮连接(勾了才连,流结束必须 close,不留孤儿子进程),用 `@modelcontextprotocol/sdk` 直连 + `dynamicTool` 包装(AI SDK v7 没有内置 MCP 客户端)。
- system prompt(`prompts/index.ts`)按**稳定性分区**:项目稳定区在前吃前缀缓存(身份/宪章/端契约/技术栈/手艺底线/技能目录),逐轮可变区在后(当前文件树/预览报错/lint 结果/收尾自检钉最后吃 recency)。**不要把逐轮变化的内容插进稳定区**——端模板(按活动端路由)与本地授权范围(带本轮识别出的路径)看着像项目属性,其实每轮都可能变,所以排在稳定区**最后一格**:前缀缓存只认第一个不同的字节,夹在中段会把后面的一起带下水。
- **Anthropic 的缓存是断点制**(`prompt-cache.ts`):请求里没有 `cache_control` 就一次都不缓存。断点标在消息上(provider 落到该消息最后一个 block,语义是"缓存到这里为止",含 tools 与 system)。一个断点**只向前回溯 20 个 block**,而一步工具调用就产生 tool-call + tool-result 两块——只标最后一条的话,几十次调用之后下一步根本够不着上一步的条目。所以从尾部往前每 15 块补一个,最多 4 个(Anthropic 上限,超了被静默忽略)。OpenAI 协议是服务端自动缓存,不认这个字段,函数对它原样返回。注入进消息的运行时提醒**不许带每步都变的计数**(那等于每步换一次前缀)。
- 质量闭环:`slop-lint.ts` 反 AI 味检查 + 预览运行时报错,都按 artifactId 绑定、下一轮回流进 prompt。
- **视觉方向机制**:项目 `styleBrief` 是整体视觉的唯一事实来源。冲突时按“用户本轮明确的全局风格 > 项目 StyleBrief > 当前产物连续性 > skills 质量护栏”处理;局部组件、单页例外不得更新 StyleBrief。空 brief 且无文件时必须先问,用户跳过后才按色彩/明暗/密度/几何/表面/导航六个独立维度生成兜底,兜底不持久化;空 brief 但已有文件时延续当前视觉。
- `design-seed` 只提供生成方法、语义 token 契约、可访问性与一致性护栏,不提供可复制的具体主题;每个项目的 `theme.css` 从 StyleBrief 生成,已有稿无 brief 时延续当前产物,首次空项目经用户跳过后才使用不持久化的独立维度 fallback。`antdv-theme` 负责把同一项目方向映射到组件 token,不是预设配方库。
- 设计体系设计与演进文档:`docs/prompt-skills-v2.md`(端模板/craft/提问机制及写作规范——规则二元化、可数化、现象化;一条规则只有一个家)。

### 多 agent 协作群组(src/main/ai/group-service.ts)

聊天室 + @ 接力:创建群组时把可配置成员完整保存为 `settings.members: GroupMember[]`，五个内置角色只作为建群模板；成员用 ULID 作为稳定身份，并各自携带人设、模型行和文件技能。用户 @ 成员发起，agent 产出 markdown 文档(消息即文档,没有 VFS/版本/代码)，每一棒使用该成员自己的模型与技能。结构化提及与精确自然 `@成员名` 的解析统一在 `shared/group-mentions.ts`。复用 conversations(kind='group')与 messages(author 存成员 ULID);事件走独立的 `group:stream` 通道;群聊记录拼成**单条** transcript(多条连续 user 消息有些供应商拒收)。agent 使用本地文件、时间和已选技能激活工具——本地文件按 workspace roots 的 conversationId 域授权。群组可编辑(`group:update`,建群/编辑共用 `GroupFormModal` 双模式弹窗):已有成员**只能改配置不能删除**(历史消息 author 引用成员 ULID,删人=发言悬空,踢人留给将来的软删除),可新增成员;接力进行中拒绝保存(每棒开始重读成员配置,链中改=中途换人设)。

**接力是树,不是链**:一条消息 @ 几位就 fan-out 几条分支**同时开跑**(`mentionAssignments` 按出现顺序、按人去重,每人只拿到自己那个 @ 到下一个 @ 之间的交代);每棒结束后 `nextMentions` 取末五行里的全部后继,再各起子分支并发。三条约束缺一不可:同一成员**串行**(两条分支同时点名一个人时后到的排队等,否则同时写两条流式消息会把 transcript 的"最新一条"与折叠规则弄坏)、并发上限 `MAX_PARALLEL`、总棒数 `MAX_TOTAL_HOPS`(`MAX_HOPS` 只管单条路径深度,管不住分叉后的总量)——都在 `group-chain.ts` 的 `HopScheduler` 与 `GroupChainGuard` 里。guard **每分叉 fork 一份**:它判的是"这条路径在不在绕圈",兄弟分支共用一个对象判出来的环是假的。并行的兄弟**看不到彼此本轮的产出**(transcript 只收非 streaming 的消息),这是并行的固有语义,由协作协议里的"你不是一个人在跑"一节明说给模型,而不是让它撞上去。每棒的任务由编排**显式带下来**(`buildGroupTranscript` 的 `assignment`),不能再从"记录里的最后一条"倒推——并行下那未必是交接给它的那位。

**交付清单是派生的,不是新表**(`shared/group-deliverables.ts`):建群时每个成员就填了 `deliverable`,消息又带 `author`,两个一拼就是清单。判据用**文档结构本身**——交付物 = 该成员**最新一条首行为一级标题**的完整消息;协作协议要求专业文档以 `#` 开头、汇合棒用 `##` 开头,于是汇合不占交付物的位、返工版本自动覆盖旧版,不加字段也不加表(内容只有 messages 一份,另存一份立刻是第二事实来源)。这一份派生同时喂三处:每棒 system 的「本轮交付清单(N/M)」(**清单才是"完成"的定义**,剩余棒数只是压力)、渲染层的交付物面板、`group:export` 的导出。导出只收交付物、剥掉末尾交接行、把结构化提及转成 `@名字`——**绝不让模型写一份"汇总文档"**(它会重抄一遍,产出翻倍且原作者的判断被悄悄改掉)。

**并行要汇合**:一棒分叉出 ≥2 条时,子分支全部落定后自动把控制权交回**派活的那个人**再跑一棒(`runBranch` 里 `settleBranches` 之后那段)。不汇合的话并行的收益只有速度——用户拿到 N 篇互不知道对方存在的文档,合并与挑冲突全靠自己脑补。汇合棒的协作协议把它锁死在**对照 + 补缺 + 定去向**上,明令"不要重写他们的文档"(模型看到三份文档最省事的做法就是重抄一遍拼成第四份,那会让产出翻倍、原作者的判断被悄悄改掉)。只在真分叉时汇合(一条是线性接力,那位手上已有全部上下文);**用户直接 @ 多位时不自动汇合**——这一层的派活人是用户,收口也归他(将来若要引入 lead 角色,它的位置就在这里)。汇合棒被 guard 拦下时**不报拦停**:文档都已落库,少一次合并是降级不是失败。

**收敛靠预算可见,不靠砍断**:`GroupChainGuard.budget()` 把"第几棒 / 还剩几棒"注入每棒的 system,剩 ≤2 棒时直接要求收口(guard 那道闸只是兜底——被拦停的表现是用户拿到一堆半成品)。协作协议里交接的门槛是**二元的**:交接理由只能是"有一件具体的、你做不了的事",评审类产出必须给「结论:通过/不通过 + 阻断性问题清单」,0 条阻断问题必须 @用户,"还能再优化"不构成交接理由,同一交付物返工最多一轮。改这里记住:**开放式建议是无限的,阻断性问题是有限的**——规则要落在后者上。

事件语义随之变化:`chain-stopped` 与 `error` 都是**分支级**的,`chain-done` 是唯一的"全部分支跑完",渲染层只认它清运行态(`stores/collab.ts` 的 `speakingByMessage` 也按 messageId 记,单值会让并行的分片串到别人消息里)。拦停仍不是终点——`chain-stopped` 带 `nextMemberId`,渲染层给「让 TA 继续接力」一键续棒(发新消息开新链,guard 随链重置,人是循环的检查点)。

transcript 有上下文预算(`group-transcript.ts`,按成员模型 contextWindow 折算):超预算时把旧发言折叠成标题骨架存根(带消息 id),**用户消息、各成员最新一条、上一棒永不折叠**,末尾重述上一棒的交接指令。收棒后异步生成滚动「前情纪要」(`group-digest.ts`,存 `group_digests` 表——派生缓存,不进同步;模型优先用全局辅助模型 assistantModel,没配才用收棒成员的模型;计量 scene='group_digest'),折叠时纪要块替换被覆盖的存根;纪要生成失败静默降级为机械折叠,绝不阻塞接力链。agent 需要被折叠的原文时用 `group-tools.ts` 的 list_group_messages / read_group_message 按行区间回读(只读幂等,共享工具预算,结果不落库)。

### 预览链路(src/main/preview/)

`preview://` 自定义协议:vue3/react 的 SFC/TSX 在**主进程**编译成 ES 模块直出(`compile.ts`,@vue/compiler-sfc / oxc-transform),iframe 里只有 import map + 挂载代码,没有编译器。要点:

- 相对导入由浏览器自己发请求回协议层,**不需要爬依赖**;
- 无后缀导入(`import '../useUsers'` → `useUsers.ts`)由 `resolve.ts` 按打包器规则补全,改解析规则必须带测试(`resolve.test.ts`);
- 裸导入靠 import map(`bootstrap.ts` 的 `VENDOR_IMPORTS`),vendor 文件由 `scripts/prepare-preview-vendor.mjs` 准备;项目勾选的组件库(`project.libs`)走 CDN import map,**加新库看 `docs/preview-libs.md` 的清单**;
- 三种栈共用 Tailwind v4 + 每项目生成的 `theme.css`(优先由 StyleBrief 驱动;首次空项目经用户跳过后可使用不持久化的独立维度 fallback,预览运行时按根路径精确匹配注入);
- 编译失败返回 200 + `throw`(不是 500):错误文本要能进 iframe 的 catch 回流给模型。
- **预览标注**(用户点元素 + 写备注给 AI):iframe 是另一个源,父窗口读不到它的 DOM,所以拾取、高亮、编号徽标全在 `annotate-runtime.ts` 里(由 `COMMON_HEAD` 内联,三种栈共用),两边只走 postMessage(`__previewCmd` 下行 / `__preview` 上行)。vue3 在编译期给普通元素注入 `data-antd-src="文件:行:列"`(`compile.ts` 的 `sourceLocTransform`;内联模板的 loc 是文件绝对行,单独编译的模板要补块偏移,`compile.test.ts` 钉住了这个口径和写死的 compiler-core 枚举值);html / react 靠元素签名让模型 `search_files`。标注**不进 IPC、不进库、不进 system prompt**——它是用户这一句话的意图,由 `attach.ts::composeMarks` 拼进消息正文,发完清空(和附带文件同一套语义),标记按 artifactId 失效。

### 渲染层关键约定(src/renderer/)

- `stores/chat.ts`:流状态**按会话隔离**(`streams: Record<conversationId, StreamState>`),每条流带缓冲(parts/activities/reasoning),消息对象与缓冲**共享引用**——切走会话增量进缓冲,切回接上,一个分片不丢。改这里先读 StreamState 的注释。
- 勾选语义:`null` = 没选过 = **什么都不加载**(和空数组等效);技能/MCP 勾选按**名字**存(没有 id)。
- 消息渲染是**链式**的:正文与工具调用按发生顺序交替(`components/message-segments.ts`),不是把工具堆在气泡底部。顺序靠 `ToolActivity.afterChars`(tool-start 时记下正文已写了多少字)恢复——工具活动不落库,没有别的办法知道"先说了什么再调的工具";缺这个字段的(从库里重新加载的老消息)一律排到末尾,退回旧行为。同一位置的并行调用合成一组交给 `ToolActivityList` 折叠。
- Monaco:复用 `@renderer/monaco/{setup,highlighter}`;`monaco/vfs.ts` 的 model 池是设计稿专用单例,别的功能要用编辑器就自建 model 自管 dispose(参考 `pages/skill-editor/`)。
- 弹窗/消息一律 `App.useApp()` 拿 `message/modal`,不静态导入(拿不到 ConfigProvider 上下文)。

## antdv-next 组件库踩坑(实测)

- Tag 的插槽会吞元素子节点,文本直接放;
- 没有 List 组件;Tree 用 `titleRender` 插槽;Drawer 尺寸用 `size`;
- 切换类 UI 优先 `a-segmented`(项目审美偏好,别用 a-tabs)。

## 其他硬约定

- 弹层内容必须封顶高度内部滚动(`max-height` + `overflow-y: auto` + `overscroll-behavior: contain`),别把页面顶出滚动条;
- 流式中的停止按钮是"暂停"不是红色危险按钮;
- 内联进 system prompt 的用户内容要转义 ``` 防 fence 越狱;来自模型/远程的 URL 过 `web/ssrf.ts` 再访问;
- 提交信息与文档用中文。
