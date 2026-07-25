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
| 技能 | 文件系统目录 | 扫描顺序即覆盖优先级:`~/.antd-designer/skills` > `~/.agents/skills` > `~/.claude/skills` > 内置 `resources/skills`(见 `skills/scan.ts`)。**没有数据库技能**,身份就是目录名 |
| MCP | `~/.antd-designer/mcp.json` | 密钥不进这个文件,走 `secrets.json`(safeStorage 加密),配置里只留 `${VAR}` 占位 |
| 市场清单 | 设置里配置的远程 `marketUrl` | 没配就是空;拉取失败不抛,状态走 `market:status` |
| 应用配置 | `~/.antd-designer/config.json` | 小而扁的键值;会增长的结构化数据进 SQLite |

历史教训:技能/MCP 曾经 DB 与文件双轨并存,两边互相看不见,最后整体删表收敛。**不要再引入第二事实来源**。

### AI 对话链路(src/main/ai/)

`chat-service.ts` 是流式编排核心,设计会话和纯聊天走同一条链路,靠 `project` 是否存在分流:

- 两种协议:模型有 tools 能力走**工具协议**(文件读写走工具、正文全是解说);长尾模型走 **markers 协议**(`<antdFile>` 全文重写)。两路共用 `SessionVfs` 落库。
- 工具调用**按次数**封顶(`MAX_TOOL_CALLS = 100`,数调用不数步——一步可并行多个调用)。
- 技能是**手动勾选制,默认零加载**:纯聊天只有勾选的技能可用(没勾连 L1 目录都没有);设计会话里内置技能(craft-* / target-* / design-seed,含被用户同名覆盖的)自动生效。勾选 = 进目录可激活(渐进披露),**没有全文注入**这条路。
- MCP 按轮连接(勾了才连,流结束必须 close,不留孤儿子进程),用 `@modelcontextprotocol/sdk` 直连 + `dynamicTool` 包装(AI SDK v7 没有内置 MCP 客户端)。
- system prompt(`prompts/index.ts`)按**稳定性分区**:项目稳定区在前吃前缀缓存(身份/宪章/端契约/端模板/技术栈/技能目录),逐轮可变区在后(当前文件树/预览报错/lint 结果/收尾自检钉最后吃 recency)。**不要把逐轮变化的内容插进稳定区**。
- 质量闭环:`slop-lint.ts` 反 AI 味检查 + 预览运行时报错,都按 artifactId 绑定、下一轮回流进 prompt。
- **多样性机制**(防"每次都长一个样"):design-seed 的品牌色是占位必换(用户方向 > brief 推断 > 色板家族表,lint 抓 `#c96442` 原样交付);每个端模板有"风格维度表",判读时逐项声明;`prompts/targets.ts` 的**风格骰子**(项目 id 派生、项目间不同项目内稳定)决定"几个选项都合适时选哪个";勾了 antdv-next 的项目必须用 `antdv-theme` 技能的配方定制组件主题(lint 抓 App.vue 无 config-provider)。改这些机制时保持三层齐动:指令(技能/契约)+ 内容(种子/配方)+ 检查器(slop-lint)。
- 设计体系设计文档:`docs/prompt-skills-v2.md`(端模板/craft/提问机制的完整设计与写作规范——规则二元化、可数化、现象化;一条规则只有一个家)。

### 多 agent 协作群组(src/main/ai/group-service.ts)

聊天室 + @ 接力:用户 @ 一个角色(五个内置角色在 `prompts/group-roles.ts`,人设与提及路由都在那)发起,agent 产出 markdown 文档(消息即文档,没有 VFS/版本/代码),末尾 @ 下一位继续,`MAX_HOPS=8` 防死循环、`nextMention` 只认末尾几行且不许 @ 自己。复用 conversations(kind='group',成员在 settings.members)与 messages(新增 author 列);事件走独立的 `group:stream` 通道;群聊记录拼成**单条** transcript(多条连续 user 消息有些供应商拒收)。agent 只有本地文件工具 + 时间工具——按会话授权目录用的是 workspace roots 的 conversationId 域。

### 预览链路(src/main/preview/)

`preview://` 自定义协议:vue3/react 的 SFC/TSX 在**主进程**编译成 ES 模块直出(`compile.ts`,@vue/compiler-sfc / oxc-transform),iframe 里只有 import map + 挂载代码,没有编译器。要点:

- 相对导入由浏览器自己发请求回协议层,**不需要爬依赖**;
- 无后缀导入(`import '../useUsers'` → `useUsers.ts`)由 `resolve.ts` 按打包器规则补全,改解析规则必须带测试(`resolve.test.ts`);
- 裸导入靠 import map(`bootstrap.ts` 的 `VENDOR_IMPORTS`),vendor 文件由 `scripts/prepare-preview-vendor.mjs` 准备;项目勾选的组件库(`project.libs`)走 CDN import map,**加新库看 `docs/preview-libs.md` 的清单**;
- 三种栈共用 Tailwind v4 + `theme.css`(设计 token 约定文件,预览运行时按根路径精确匹配注入);
- 编译失败返回 200 + `throw`(不是 500):错误文本要能进 iframe 的 catch 回流给模型。

### 渲染层关键约定(src/renderer/)

- `stores/chat.ts`:流状态**按会话隔离**(`streams: Record<conversationId, StreamState>`),每条流带缓冲(parts/activities/reasoning),消息对象与缓冲**共享引用**——切走会话增量进缓冲,切回接上,一个分片不丢。改这里先读 StreamState 的注释。
- 勾选语义:`null` = 没选过 = **什么都不加载**(和空数组等效);技能/MCP 勾选按**名字**存(没有 id)。
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
