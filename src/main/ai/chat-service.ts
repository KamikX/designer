import { randomUUID } from 'crypto'
import { parsePartialJson, streamText } from 'ai'
import type { ModelMessage, StepResult, ToolSet } from 'ai'
import type { WebContents } from 'electron'
import type {
  AskUserAnswer,
  ChatStreamEvent,
  ChatUsage,
  Message,
  MessagePart,
  SendChatInput,
  SendChatResult,
  WorkspaceRoot
} from '../../shared/types'
import { readConfig } from '../config'
import { getModel } from '../db/repo/model'
import { getProviderRowById } from '../db/repo/provider'
import { createMessage, listMessages, updateMessage } from '../db/repo/message'
import { openaiCompatOptions } from './provider-options'
import { autoTitle, getConversation, touchConversation } from '../db/repo/conversation'
import { getProject, setProjectStyleBrief, touchProject } from '../db/repo/project'
import { createArtifactVersion, getArtifactFiles, latestArtifact } from '../db/repo/artifact'
import { buildHistory } from './context'
import { buildSystemPrompt } from './prompts'
import { lintArtifact } from './slop-lint'
import { compileProbe } from './compile-probe'
import { pendingLint, recordLint } from './lint-store'
import { buildChatPrompt } from './prompts/chat'
import { buildTimeTools } from './time-tools'
import { scanSkills, skillRoots } from '../skills/scan'
import { skillCatalog } from '../skills/catalog'
import { loadTargetTemplates } from '../skills/targets'
import {
  renderCompatNote,
  renderTargetTemplates,
  routeActiveTargets,
  targetContractPrompt
} from './prompts/targets'
import {
  awaitMarkerUsageBeforeCommit,
  buildStyleBriefTools,
  commitMarkerStyleBrief,
  createInitialStyleWriteGate,
  markerCompletionOutcome,
  renderStyleBriefPrompt
} from './style-brief'
import type { MarkerStyleCommitResult } from './style-brief'
import { createChatFinalizeCoordinator } from './chat-finalizer'
import type { ChatFinalizeResult } from './chat-finalizer'
import { connectMcpTools } from '../mcp/tools'
import type { McpSession } from '../mcp/tools'
import { buildSkillTools } from '../skills/tools'
import { buildInstallTools } from '../skills/install-tools'
import { buildWebTools } from '../web/tools'
import { closeBrowserSession } from '../web/session'
import { FileStreamParser } from './file-stream-parser'
import { SessionVfs } from './session-vfs'
import { RunContextLedger } from './run-context-ledger'
import {
  ContextGovernor,
  ToolBudgetGate,
  effectiveToolCallLimit,
  resolveToolLimits,
  wrapToolsWithBudget
} from './context-governor'
import { withCacheBreakpoints } from './prompt-cache'
import { buildFileTools } from './tools'
import { askUser, buildAskUserTool, releaseQuestions } from './ask-user'
import { buildImageTools } from './image-tools'
import { buildCaptureTools } from './capture-tools'
import { registerSessionPreview, unregisterSessionPreview } from '../preview/session-registry'
import { buildLocalTools, localScopePrompt } from './local-tools'
import { addRoot, listRoots } from '../workspace/roots'
import type { RootScope } from '../workspace/roots'
import { pendingPreviewError, previewErrorPrompt } from '../preview/errors'
import { detectPaths } from '../workspace/detect'
import { executingLabel, labelFor, preparingLabel, summarize, verbOf } from './tool-activity'
import { normalizeStepUsage } from './usage'
import { errorMessage, getLanguageModel } from './registry'
import { RunTraceCollector } from './run-trace'
import { mapToolErrorCode } from './tool-trace-sanitizer'
import type { AdapterType } from '../../shared/types'
import { getAssetRecord } from '../db/repo/asset'
import { resolveAsset } from '../storage/service'

/**
 * 流式对话编排。
 *
 * 协议:invoke 发起立即返回 streamId(两条消息已落库,assistant 置
 * streaming),之后所有增量走 `chat:stream` 单通道 send,渲染层按
 * streamId 路由。发送目标用发起请求的 WebContents——天然对准正确窗口。
 *
 * 按模型能力分两条路,共用同一个落库出口(SessionVfs):
 * - tools:模型支持工具调用,文件读写走 list/read/edit/write/delete 工具,
 *   改一处只发一个 patch,输出 token 降一个数量级;正文全是解说。
 * - markers:长尾模型的兜底,老的 <antdFile> 全文重写协议,经
 *   FileStreamParser 分流后把结果灌进同一个 VFS。
 *
 * finalize 只认 VFS 一个来源,两条路的落库行为完全一致。
 */

/**
 * 工具调用预算交给 ContextGovernor 的 20/30/40 分级策略;这里只留计数
 * 帮助区分触顶原因。按调用次数数而不是按步数:一步可以并行发多个调用,
 * 步数上限对"每步塞满并行调用"的模型形同虚设。触顶后已完成的改动照常落库。
 */
function countToolCalls(steps: readonly StepResult<ToolSet>[]): number {
  return steps.reduce((n, s) => n + s.toolCalls.length, 0)
}

const running = new Map<string, AbortController>()

export function sendChat(sender: WebContents, input: SendChatInput): SendChatResult {
  const conversation = getConversation(input.conversationId)
  if (!conversation) throw new Error('会话不存在')

  /**
   * 两种会话走同一条链路,靠 project 是否存在分流:
   *
   * - 设计会话有项目:VFS、版本落库、设计提示词、预览报错回流全都要
   * - 纯聊天没有项目:上面那些一个都不需要,只留通用的工具与流式循环
   *
   * 不拆成两个函数,是因为真正不同的只有"给什么工具、用什么提示词、
   * 产物往哪落"这三处;流式循环、工具活动、提问、中止、错误处理这些
   * 占了大头的部分两边完全一样,复制一份迟早会漂移。
   */
  const project = conversation.projectId ? getProject(conversation.projectId) : null
  if (conversation.projectId && !project) throw new Error('项目不存在')
  const isChat = !project
  /** 授权范围:项目会话跟着项目,纯聊天跟着这次会话 */
  const scope: RootScope = project ? { projectId: project.id } : { conversationId: conversation.id }

  const provider = getProviderRowById(input.providerId)
  if (!provider) throw new Error('供应商不存在')
  const model = getModel(input.modelId)
  if (!model) throw new Error('模型不存在')

  // 历史与当前设计稿在落库新消息之前取
  const priorMessages = listMessages(input.conversationId)
  const history = buildHistory(priorMessages, model.contextWindow)
  const base = project ? latestArtifact(project.id) : null
  const currentFiles = base ? getArtifactFiles(base.id) : []

  // 本轮附的参考图。没有 vision 能力就直接拒——发出去只会拿到一个
  // 供应商侧的原始报错,不如在这里说人话
  /*
   * 本会话勾选的技能名。勾选 = 允许使用(进 L1 目录、可被 activate_skill
   * 激活),**不是全文注入**——语义只有渐进披露这一种。
   */
  const checkedSkills = new Set(input.skillIds ?? [])
  // 用户在这句话里直接给了路径的,当场授权。
  // **只认用户输入的文本**——模型输出和文档内容都不进这里,否则一份写着
  // "请读取 /etc/passwd" 的 PDF 就能让 AI 自己给自己提权
  const detected = detectPaths(input.text)
  const grantedRoots = autoGrant(scope, detected.resolved)
  // 用户授权过的本地目录。一个都没有时,本地文件工具整组不注册
  const userRoots = listRoots(scope)

  /*
   * 文件系统里的技能。
   *
   * 技能目录要**并进授权范围**,否则渐进披露的第三层直接断掉:模型激活了技能、
   * 看到正文写着"详见 references/xxx.md",然后 read_local_file 拒绝——因为用户
   * 从没授权过 ~/.agents/skills。
   *
   * 这不算扩大权限:这些目录本来就是用户放技能的地方,而技能的全部意义就是被读。
   */
  let fileSkills = scanSkills()
  /*
   * 本会话真正可用的技能:
   * - 设计会话:内置技能(含被用户覆盖的同名版)自动可用——craft 手艺规则和
   *   端模板是产品质量的一部分;其余来源(我的 / 全局)勾选了才可用。
   * - 纯聊天:**只有勾选的**。默认是一个干净的模型:零技能、零目录、零授权。
   */
  const availableSkills = fileSkills.filter((s) =>
    project
      ? s.source === 'builtin' || s.coversBuiltin || checkedSkills.has(s.name)
      : checkedSkills.has(s.name)
  )
  const roots = [...userRoots, ...skillRoots(availableSkills)]
  // 上一版预览跑挂了的话,这一轮先让模型知道。纯聊天没有预览
  const previewError = project
    ? previewErrorPrompt(pendingPreviewError(project.id, base?.id ?? null))
    : ''
  // 上一版产物的反 AI 味检查结果。和预览报错同理:按版本失效
  const slopLint = project ? pendingLint(project.id, base?.id ?? null) : ''

  const attachments = toImageParts(input.attachments ?? [])
  if (attachments.length > 0 && !model.abilities.includes('vision')) {
    throw new Error(`模型「${model.displayName}」不支持识图,请换一个带识图能力的模型再发图片。`)
  }

  const userMessage = createMessage({
    conversationId: input.conversationId,
    role: 'user',
    parts: [{ type: 'text', text: input.text }, ...attachments]
  })
  const assistantMessage = createMessage({
    conversationId: input.conversationId,
    role: 'assistant',
    parts: [],
    status: 'streaming',
    providerSlug: provider.slug,
    modelId: model.modelId
  })
  if (project) touchProject(project.id)
  else {
    // 聊天列表按最近活跃排序,并用首句给这条聊天起个名字
    touchConversation(conversation.id)
    autoTitle(conversation.id, input.text)
  }

  const streamId = randomUUID()
  const abort = new AbortController()
  running.set(streamId, abort)

  /**
   * 运行追踪:设计会话记 design,纯聊天记 chat。采集器只观察不干预,
   * 任何落库失败都被它自己吞掉,不影响本轮生成。
   */
  const trace = new RunTraceCollector({
    scene: project ? 'design' : 'chat',
    messageId: assistantMessage.id,
    conversationId: conversation.id,
    projectId: project?.id ?? null,
    providerId: provider.id,
    providerSlug: provider.slug,
    modelId: model.modelId,
    adapter: provider.adapter as AdapterType
  })

  const emit = (event: ChatStreamEvent): void => {
    if (!sender.isDestroyed()) sender.send('chat:stream', event)
  }

  const providerAdapter = provider.adapter as AdapterType
  const useTools = model.abilities.includes('tools')
  const canSeeImages = model.abilities.includes('vision')
  const vfs = new SessionVfs(currentFiles)
  /**
   * 截图自审的预览源:多模态模型 + 设计会话才注册。files 是活引用——
   * 截图发生在模型连续编辑之间,必须看到 VFS 的最新状态而不是开流快照
   */
  const captureSessionId = project && useTools && canSeeImages ? randomUUID() : null
  if (captureSessionId && project) {
    registerSessionPreview(captureSessionId, {
      stack: project.stack,
      libs: project.libs ?? [],
      files: () => vfs.list().map((path) => vfs.raw(path))
    })
  }
  /** 回合账本:锚点、指纹、失败熔断都以它为准,跟这一轮同生共死 */
  const runLedger = new RunContextLedger()
  /**
   * 同步名额闸门 + step 级治理:软阈值压缩 / 禁重读 / 硬上限,3×/5× 窗口。
   * 硬上限来自用户配置(项目覆盖 > 全局),0 = 不限,另两档按比例派生。
   */
  const toolLimits = resolveToolLimits(
    effectiveToolCallLimit(project?.settings?.toolCallLimit, readConfig().toolCallLimit)
  )
  const budgetGate = new ToolBudgetGate(toolLimits.hard)
  const governor = new ContextGovernor({
    ledger: runLedger,
    gate: budgetGate,
    contextWindow: model.contextWindow,
    limits: toolLimits
  })
  const initialStyleGate = project
    ? createInitialStyleWriteGate({
        styleBrief: project.styleBrief ?? '',
        hasFiles: currentFiles.length > 0,
        useTools
      })
    : null
  if (initialStyleGate?.isLocked()) {
    vfs.blockWrites(
      '请先确认整体视觉方向；有答案时先调用 set_style_brief 保存，跳过后才可使用兜底风格。'
    )
  }
  const parser = new FileStreamParser()
  /** 正常完成的 markers 提交若被风格事务拒绝，catch 不得把同一批文件重新灌入。 */
  let markerCommitRejected = false
  /** 一旦开始等待 usage 或提交 markers，catch 绝不对同一轮二次提交。 */
  let markerCommitAttempted = false
  let markerCommit: MarkerStyleCommitResult | null = null
  let toolStyleSaved = false
  /** tools 路的解说自己累计;markers 路用 parser.narration */
  let toolNarration = ''
  /** 本回合的问答,按发生顺序;finalize 时连答案一起存进消息 */
  const questionParts: Extract<MessagePart, { type: 'question' }>[] = []
  /** 工具入参是逐字到达的,按 callId 攒着,边攒边算展示标签 */
  const toolInputs = new Map<string, { toolName: string; json: string; label: string }>()
  /** SDK 报告的本地执行耗时,tool-end 事件带给渲染层做 500ms 性能警告 */
  const toolExecMs = new Map<string, number>()

  const relay = (events: ReturnType<FileStreamParser['push']>): void => {
    for (const e of events) {
      switch (e.type) {
        case 'text':
          emit({ streamId, type: 'delta', text: e.text })
          break
        case 'file-start':
          // markers 路的"首个文件变化"在这里
          trace.markFirstFilePatch()
          emit({ streamId, type: 'file-start', path: e.path })
          break
        case 'file-delta':
          emit({ streamId, type: 'file-delta', path: e.path, text: e.text })
          break
        case 'file-end':
          emit({ streamId, type: 'file-end', path: e.path })
          break
        case 'file-delete':
          emit({ streamId, type: 'file-delete', path: e.path })
          break
      }
    }
  }

  /*
   * 本轮连接的 MCP 会话,流结束(含出错)后必须关掉,不留孤儿子进程。
   *
   * 声明必须在 void run() **之前**:run 是函数声明会被提升,调用时同步执行到
   * 读 mcp 的那行,声明在调用之后的话就是暂时性死区,直接 ReferenceError。
   */
  let mcp: McpSession | null = null
  const finalizer = createChatFinalizeCoordinator<ReturnType<typeof createArtifactVersion>>({
    artifactId: (artifact) => artifact.id,
    restoreStyle: (styleBrief) => (project ? setProjectStyleBrief(project.id, styleBrief) : null),
    settle: settleFinalMessage,
    emitDone: (result) => {
      if (result.usage) emit({ streamId, type: 'usage', usage: result.usage })
      emit({
        streamId,
        type: 'done',
        messageId: assistantMessage.id,
        artifactId: result.artifactId
      })
    },
    emitError: (error, artifactId) =>
      emit({ streamId, type: 'error', message: errorMessage(error), artifactId })
  })

  void run()

  async function run(): Promise<void> {
    trace.start()
    try {
      /*
       * MCP:勾选的才连,默认一个都不连。连接失败的服务不拖垮整轮,
       * 原因作为一行说明出现在解说里。
       */
      const mcpNames = input.mcpIds ?? []
      if (useTools && mcpNames.length > 0) {
        mcp = await connectMcpTools(mcpNames)
        if (mcp.warnings.length) {
          const note = `${mcp.warnings.map((w) => `(${w})`).join('\n')}\n\n`
          toolNarration += note
          emit({ streamId, type: 'delta', text: note })
        }
      }

      const tools = useTools
        ? {
            // 设计稿的文件工具只给设计会话。纯聊天没有产物,给了它反而会
            // 去"写文件",写到一个谁也看不见的 VFS 里
            ...(project
              ? buildFileTools(
                  vfs,
                  {
                    onPatch: (patch) => {
                      // 用户第一次看到产物变化的时刻,进运行诊断
                      trace.markFirstFilePatch()
                      emit({
                        streamId,
                        type: 'file-patch',
                        path: patch.path,
                        oldText: patch.oldText,
                        newText: patch.newText,
                        ...(patch.replaceAll ? { replaceAll: true } : {})
                      })
                    },
                    onDelete: (path) => emit({ streamId, type: 'file-delete', path })
                  },
                  { ledger: runLedger, readGate: (path, rev) => governor.readGate(path, rev) }
                )
              : {}),
            // 整体视觉方向是项目数据；纯聊天没有项目，因而不暴露此工具。
            ...buildStyleBriefTools(
              project
                ? {
                    projectId: project.id,
                    initialHasFiles: currentFiles.length > 0,
                    vfs,
                    save: (styleBrief) => setProjectStyleBrief(project.id, styleBrief),
                    onSaved: () => {
                      toolStyleSaved = true
                    },
                    onDiscard: (changes) => {
                      for (const change of changes) {
                        if (!vfs.existedAtStart(change.path)) {
                          emit({ streamId, type: 'file-delete', path: change.path })
                          continue
                        }
                        emit({
                          streamId,
                          type: 'file-patch',
                          path: change.path,
                          oldText: '',
                          newText: change.before
                        })
                      }
                    }
                  }
                : null
            ),
            // 无条件内置:模型对"今天是几号"只有训练截止时的印象,而且它
            // 意识不到这一点——不给它这个,涉及日期的输出会自信地错
            ...buildTimeTools(),
            ...buildSkillTools(availableSkills),
            // 装技能 / 装 MCP。两个都强制走 ask_user——它们改的是用户机器上的
            // 持久状态,模型不该自己拍板
            ...buildInstallTools({
              ask: async (ask) => {
                const askContext = {
                  streamId,
                  signal: abort.signal,
                  emit: (questionId: string, input: typeof ask) =>
                    emit({ streamId, type: 'question', questionId, ask: input }),
                  onAnswered: (questionId: string, input: typeof ask, answer: AskUserAnswer) =>
                    questionParts.push({ type: 'question', questionId, ask: input, answer })
                }
                return (await askUser(askContext, ask)).answer
              },
              onChanged: () => {
                // 下一轮重扫,新装的技能才会出现在目录里
                fileSkills = scanSkills()
              }
            }),
            ...buildWebTools(input.webSearch === true, streamId),
            ...buildAskUserTool({
              streamId,
              signal: abort.signal,
              emit: (questionId, ask) => emit({ streamId, type: 'question', questionId, ask }),
              onAnswered: (questionId, ask, answer) => {
                questionParts.push({ type: 'question', questionId, ask, answer })
                // 安装类工具走它们自己的 askUser context，不会触发这个回调；
                // 其他普通 ask_user 也不能解锁；只有显式的首次风格确认才可以。
                if (ask.purpose === 'style-brief') {
                  initialStyleGate?.onStyleQuestionAnswered(ask, answer)
                  if (initialStyleGate && !initialStyleGate.isLocked()) vfs.allowWrites()
                }
              }
            }),
            ...buildLocalTools(roots, { canSeeImages, intent: input.text }),
            ...buildImageTools({
              assets: knownImages(priorMessages, attachments),
              onNote: (assetId, description) =>
                noteImage(input.conversationId, assetId, description)
            }),
            // 截图自审:多模态模型才给——拍了看不见等于白拍
            ...(captureSessionId
              ? buildCaptureTools({
                  sessionId: captureSessionId,
                  hasFiles: () => vfs.list().length > 0
                })
              : {}),
            // MCP 排最后:名字带服务前缀,不会和内置工具撞
            ...(mcp ? mcp.tools : {})
          }
        : undefined

      /*
       * 端模板:项目勾了哪些端,就把哪些端的模板正文在组装期直接注入。
       * 不走 activate_skill——路由已经由勾选决定,不该再赌模型"想起来"加载;
       * markers 模式没有工具,这也是它拿到端规范的唯一途径。
       * 已注入的端技能要从 L1 目录里去掉,不然同一份内容出现两次白占预算。
       */
      const targets = project?.targets ?? []
      /*
       * 活动目标路由:多端项目每轮只注入活动端的完整模板。完整模板动辄
       * 几千 token,不活动的端只留一句兼容契约——代价是端切换那一轮会
       * 破一次前缀缓存,换来的是每一步都少发几份全文。
       */
      const targetRoute = routeActiveTargets({ targets, userText: input.text, currentFiles })
      const targetTemplates = project ? loadTargetTemplates(fileSkills, targetRoute.active) : []
      const injectedTargets = new Set(targetTemplates.map((t) => t.name))
      const catalogSkills = availableSkills.filter((s) => !injectedTargets.has(s.name))
      // 目录只列**本会话可用**的技能:纯聊天没勾就是空,连目录都不出现
      const catalog = useTools ? skillCatalog(catalogSkills, model!.contextWindow) : ''
      const system = project
        ? buildSystemPrompt(project, currentFiles, {
            mode: useTools ? 'tools' : 'markers',
            localScope: localScopePrompt(userRoots, detected.missing),
            previewError,
            slopLint,
            skillCatalog: catalog,
            styleBriefPrompt: renderStyleBriefPrompt(
              project,
              currentFiles.length > 0,
              useTools ? 'tools' : 'markers'
            ),
            targetContract: [
              targetContractPrompt(targetRoute.active),
              renderCompatNote(targetRoute.compat)
            ]
              .filter(Boolean)
              .join('\n\n'),
            targetTemplates: renderTargetTemplates(targetTemplates),
            captureHint: !!captureSessionId
          })
        : buildChatPrompt({
            localScope: localScopePrompt(userRoots, detected.missing),
            webSearch: input.webSearch === true,
            skillCatalog: catalog
          })

      // 图片字节到这里才读:sendChat 本身是同步的,不能 await
      const pixels = await loadAttachmentBytes(attachments)

      const result = streamText({
        model: getLanguageModel(input.providerId, model!.modelId),
        /*
         * 纯聊天默认**不带任何人设**——不预设它是设计师、不预设输出格式。
         * 只在真的有东西要交代时(授权了目录、勾了技能、开了联网)才给一段,
         * 而且只说那件事。空着就整个不传 system,和网页版聊天一样。
         */
        ...(system ? { system } : {}),
        // OpenAI 协议的兼容开关,见 config.ts。默认最保守:不依赖服务端
        // 持久化,也不用任何非标准选项
        providerOptions: { openai: openaiCompatOptions() },
        messages: [
          ...history,
          {
            role: 'user',
            // 只有本轮的图带像素;历史里的图在 buildHistory 里已经降成
            // 文字引用了,要看得靠 view_image
            content: [{ type: 'text', text: input.text }, ...pixels]
          }
        ],
        abortSignal: abort.signal,
        // 运行追踪:模型请求与本地工具执行的精确相位。回调只观察不干预
        onLanguageModelCallStart: ({ callId }) => trace.modelCallStart(callId),
        onLanguageModelCallEnd: (event) => {
          // step 用量立刻回流账本:治理器的 3×/5× 熔断以已上报值优先
          runLedger.addUsage(normalizeStepUsage(event.usage, { adapter: providerAdapter }))
          trace.stepEnd(event.callId, event.usage, {
            finishReason: event.finishReason,
            responseTimeMs: event.performance?.responseTimeMs ?? null,
            timeToFirstOutputMs: event.performance?.timeToFirstOutputMs ?? null
          })
        },
        onToolExecutionStart: (event) => {
          const id = event.toolCall.toolCallId
          trace.toolExecutionStart(id)
          // 相位从"准备"翻到"执行":这一刻起才是本地在干活
          const entry = toolInputs.get(id)
          emit({
            streamId,
            type: 'tool-exec',
            callId: id,
            label: executingLabel(
              event.toolCall.toolName,
              entry ? entry.label : verbOf(event.toolCall.toolName)
            )
          })
        },
        onToolExecutionEnd: (event) => {
          toolExecMs.set(event.toolCall.toolCallId, Math.round(event.toolExecutionMs))
        },
        ...(tools
          ? {
              // 所有工具共用同一个同步闸门:单个 step 一次吐出超额并行调用时,
              // 只有预留到名额的会执行,其余原地返回 TOOL_BUDGET_EXCEEDED
              tools: wrapToolsWithBudget(tools, budgetGate),
              stopWhen: () => governor.shouldStop(),
              prepareStep: ({ messages }: { messages: ModelMessage[] }) => {
                // 序列化字符数做保守估算的分母;system 一并计入
                const serializedChars = JSON.stringify(messages).length + (system?.length ?? 0)
                const governed = governor.prepareStep({ messages, serializedChars })
                /*
                 * 缓存断点每步重打:工具协议下一步就往尾部加好几个 block,
                 * 断点必须跟着走,否则下一步的回溯窗口够不着上一步的条目。
                 * 内容字节没变,挪断点不会让前缀失效(见 prompt-cache.ts)。
                 */
                return {
                  messages: withCacheBreakpoints(governed.messages ?? messages, providerAdapter)
                }
              }
            }
          : {})
      })

      // MCP 工具按键名识别:sanitizer 对它们只保留 server_tool 名
      const mcpToolNames = new Set(Object.keys(mcp?.tools ?? {}))

      // 用 fullStream 而不是 textStream:后者只吐模型的文字,而工具协议下
      // 模型调工具的那几十秒根本不产文字——聊天框就是死的。工具的生命
      // 周期事件都在 fullStream 里
      //
      // 但两者的**错误语义不一样**:textStream 出错会 reject,fullStream 是
      // 把错误当成一个 part 发出来,然后流正常结束。所以下面的 catch 对它
      // 无效,必须显式接住 'error' ——否则上游 502 之类的失败会被静默吞掉,
      // 表现成"聊到一半自己停了,什么都不说"。
      let streamError: unknown = null
      let modelAborted = false
      for await (const part of result.fullStream) {
        if (part.type === 'error') {
          streamError = part.error
          break
        }
        // 模型侧主动中止(不是用户点的停):当成中止而非报错
        if (part.type === 'abort') {
          modelAborted = true
          break
        }
        switch (part.type) {
          case 'text-delta': {
            trace.markFirstOutput()
            if (useTools) {
              toolNarration += part.text
              emit({ streamId, type: 'delta', text: part.text })
            } else {
              relay(parser.push(part.text))
            }
            break
          }
          case 'reasoning-delta': {
            trace.markFirstOutput()
            emit({ streamId, type: 'reasoning', text: part.text })
            break
          }
          case 'tool-input-start': {
            trace.toolInputStart(part.id, part.toolName, { mcp: mcpToolNames.has(part.toolName) })
            // 这一刻只是模型开始生成参数,编辑族必须显示"准备X"而不是"应用X"
            const label = preparingLabel(part.toolName, verbOf(part.toolName))
            toolInputs.set(part.id, { toolName: part.toolName, json: '', label })
            emit({ streamId, type: 'tool-start', callId: part.id, toolName: part.toolName, label })
            break
          }
          case 'tool-input-delta': {
            // 入参逐字到达,path 通常最先出现(字段顺序跟 schema 走)。
            // 半截 JSON 也要能出标签——早一秒告诉用户在写哪个文件
            const entry = toolInputs.get(part.id)
            if (!entry) break
            entry.json += part.delta
            /*
             * 标签一旦解析出来就不再变(它只取 path/name/query 这类**开头就
             * 出现**的短字段),后面的 delta 不必再解析。这不是小优化:
             * parsePartialJson 每次都要过整段累积 JSON,write_file 的 content
             * 动辄几十 KB,逐 delta 全量重解析是 O(n²)——实测会把整个流
             * 消费循环拖住,所有事件堵到生成结束才放出来,界面上表现成
             * "文件全写完了才一次性出现"。
             */
            if (entry.label !== preparingLabel(entry.toolName, verbOf(entry.toolName))) break
            const parsed = await parsePartialJson(entry.json)
            const next = preparingLabel(
              entry.toolName,
              labelFor(entry.toolName, parsed.value as Record<string, unknown>)
            )
            if (next !== entry.label) {
              entry.label = next
              emit({ streamId, type: 'tool-update', callId: part.id, label: next })
            }
            break
          }
          case 'tool-call': {
            // 补一个开始(供应商不流式吐入参时没有 tool-input-start),再记入参完成
            trace.toolInputStart(part.toolCallId, part.toolName, {
              mcp: mcpToolNames.has(part.toolName)
            })
            trace.toolInputEnd(
              part.toolCallId,
              part.input,
              toolInputs.get(part.toolCallId)?.json.length ?? null
            )
            const label = preparingLabel(
              part.toolName,
              labelFor(part.toolName, part.input as Record<string, unknown>)
            )
            // 有些供应商不流式吐入参,压根没有 tool-input-start。这里补一个
            // 开始事件,否则渲染层会收到一条没有开头的更新
            if (!toolInputs.has(part.toolCallId)) {
              toolInputs.set(part.toolCallId, { toolName: part.toolName, json: '', label })
              emit({
                streamId,
                type: 'tool-start',
                callId: part.toolCallId,
                toolName: part.toolName,
                label
              })
            } else {
              emit({ streamId, type: 'tool-update', callId: part.toolCallId, label })
            }
            break
          }
          case 'tool-result': {
            const { ok, summary } = summarize(part.toolName, part.output)
            // 本仓库的工具以"错误文本作为结果"表达可恢复失败,ok=false 即是
            trace.toolExecutionEnd(part.toolCallId, {
              status: ok ? 'success' : 'recoverable_error',
              outputChars: typeof part.output === 'string' ? part.output.length : null,
              ...(ok ? {} : { errorSummary: summary ?? null })
            })
            emit({
              streamId,
              type: 'tool-end',
              callId: part.toolCallId,
              ok,
              summary,
              status: ok ? 'success' : 'recoverable_error',
              ...(toolExecMs.has(part.toolCallId)
                ? { execMs: toolExecMs.get(part.toolCallId) }
                : {})
            })
            break
          }
          case 'tool-error': {
            // 工具抛异常(而不是返回错误文本)是意料外失败
            trace.toolExecutionEnd(part.toolCallId, {
              status: 'fatal_error',
              errorCode: mapToolErrorCode(part.error),
              errorSummary: errorMessage(part.error)
            })
            emit({
              streamId,
              type: 'tool-end',
              callId: part.toolCallId,
              ok: false,
              summary: errorMessage(part.error),
              status: 'fatal_error',
              ...(toolExecMs.has(part.toolCallId)
                ? { execMs: toolExecMs.get(part.toolCallId) }
                : {})
            })
            break
          }
        }
      }
      if (streamError) {
        // 流已经废了,这几个 promise 也会 reject。没人 await 就是
        // unhandled rejection,先各自吞掉再抛
        // 都是 PromiseLike,包一层才有 catch
        void Promise.resolve(result.usage).catch(() => {})
        void Promise.resolve(result.finishReason).catch(() => {})
        void Promise.resolve(result.steps).catch(() => {})
        // 抛给下面的 catch:落库策略和中止判定都在那儿,不重复一遍
        throw streamError
      }

      let markerUsage: Awaited<typeof result.usage> | null = null
      if (!useTools) {
        markerCommitAttempted = true
        try {
          const settled = await awaitMarkerUsageBeforeCommit(result.usage, () =>
            commitMarkers(markerCompletionOutcome(modelAborted))
          )
          markerUsage = settled.usage
          markerCommit = settled.commit
        } catch (err) {
          markerCommitRejected = true
          throw err
        }
      }

      // 触顶说明模型还没收手,按中止处理并在解说里交代
      const cappedOut =
        useTools && (await result.finishReason) === 'tool-calls' && governor.shouldStop()

      const usage = markerUsage ?? (await result.usage)
      if (cappedOut) {
        // 分清是工具次数还是 token 预算触顶,诊断里也各记各的熔断
        const hitTool = governor.hitToolLimit(countToolCalls(await result.steps))
        trace.setBreaker(hitTool ? 'tool' : 'token')
        // 两种触顶给的下一步不一样:次数触顶可以去设置里调高,token 触顶只能拆需求
        const reason = hitTool
          ? `本轮工具调用已达上限(${governor.hardLimitText()},可在设置或项目里调整)`
          : '本轮累计输入已超上下文预算'
        const note = `\n\n(${reason},先停在这里。改动已保存,可以继续让我接着改。)`
        toolNarration += note
        emit({ streamId, type: 'delta', text: note })
      }
      // 本轮发生过致命一致性错误:绝不产出与 VFS 状态存疑的新版本
      if (useTools && !runLedger.canFinalizeArtifact()) {
        throw new Error(
          `本轮发生致命一致性错误(${runLedger.fatalLockReason()}),已中止,不产出新版本。`
        )
      }
      // 熔断类型在上面按 tool / token 分好了,这里不能再无条件盖成 'tool'
      trace.finish(cappedOut || modelAborted ? 'aborted' : 'complete')
      await finalize(cappedOut || modelAborted ? 'aborted' : 'complete', {
        inputTokens: usage.inputTokens ?? 0,
        outputTokens: usage.outputTokens ?? 0,
        // 详细细分(缓存/思考)来自回合账本的逐 step 累计;历史消息没有这块,
        // 展示层把 undefined 当"历史未知"
        details: runLedger.cumulativeUsage
      })
    } catch (err) {
      trace.finish(abort.signal.aborted ? 'aborted' : 'error')
      if (!useTools && !markerCommitAttempted && !markerCommitRejected) {
        await commitMarkers(abort.signal.aborted ? 'aborted' : 'error')
      }
      if (abort.signal.aborted) {
        // 中止不算错误:已执行的工具调用 / 已解析完成的文件照常成版本
        await finalize('aborted', null)
      } else {
        await finalize('error', null, err)
      }
    } finally {
      // 还挂着的提问一律按跳过放掉,否则那个 Promise 永远不 resolve
      releaseQuestions(streamId)
      // 截图预览源随流注销,不然协议层会一直握着这轮 VFS 的引用
      if (captureSessionId) unregisterSessionPreview(captureSessionId)
      // 无头窗口不会自己消失,漏一次就常驻一个隐藏的渲染进程——
      // 用户只会看到内存莫名其妙涨上去
      closeBrowserSession(streamId)
      // stdio 的 MCP 是子进程,不关就常驻;close 自己兜错,不会抛
      void mcp?.close()
      running.delete(streamId)
    }
  }

  async function commitMarkers(
    outcome: 'complete' | 'aborted' | 'error'
  ): Promise<MarkerStyleCommitResult | null> {
    relay(parser.finish())
    if (!project) {
      vfs.ingest(parser.files, parser.deleted)
      return null
    }
    return commitMarkerStyleBrief({
      parser,
      vfs,
      initialStyleBrief: project.styleBrief ?? '',
      initialHasFiles: currentFiles.length > 0,
      outcome,
      save: (styleBrief) => setProjectStyleBrief(project.id, styleBrief)
    })
  }

  /** 唯一收尾入口：协调版本、StyleBrief 补偿、消息状态和结束事件。 */
  async function finalize(
    status: 'complete' | 'aborted' | 'error',
    usage: ChatUsage | null,
    error?: unknown
  ): Promise<ChatFinalizeResult> {
    const narration = (useTools ? toolNarration : parser.narration).trim()
    const writes = vfs.writes
    const deletes = vfs.deletes

    // 出错时是否保留已完成的改动,两条路结论相反:
    //
    // - tools 路:每次编辑都是一个**已经成功返回**的工具调用,是完整的。上游
    //   502 在第 11 步挂掉,不该让前 10 步的改动一起蒸发——那等于让用户从头
    //   再来一遍。存下来,下一轮以它为基线接着改。
    // - markers 路:文件内容是从流里边收边解析的,断在中间就是**半个文件**,
    //   存下来必然是坏的。宁可丢掉。
    const keepWork = status !== 'error' || useTools

    const styleCommit: MarkerStyleCommitResult = useTools
      ? {
          styleSaved: toolStyleSaved,
          previousStyleBrief: project?.styleBrief ?? '',
          hasFileOutput: vfs.hasChanges
        }
      : (markerCommit ?? {
          styleSaved: false,
          previousStyleBrief: project?.styleBrief ?? '',
          hasFileOutput: vfs.hasChanges
        })

    return finalizer.finalize({
      status,
      usage,
      error,
      styleCommit,
      ...(!isChat && keepWork && vfs.hasChanges && runLedger.canFinalizeArtifact()
        ? {
            createArtifact: () =>
              createArtifactVersion({
                projectId: project!.id,
                messageId: assistantMessage.id,
                baseArtifactId: base?.id ?? null,
                writes,
                deletes,
                summary: narration.slice(0, 200)
              })
          }
        : {})
    })
  }

  function settleFinalMessage(result: ChatFinalizeResult): void {
    const narration = (useTools ? toolNarration : parser.narration).trim()
    const writes = vfs.writes
    const deletes = vfs.deletes

    if (result.artifactId) {
      /*
       * 检查本轮产物,结果留到下一轮进提示词。
       *
       * 提示词里写"不要用靛蓝"只是倾向,模型仍然会用;而"你第 12 行有 #6366f1"
       * 是事实,绕不过去。这条回流是我们相对纯提示词方案唯一的结构性优势。
       */
      // StyleBrief 从库里重取:本轮 set_style_brief 更新过的话,内存里的 project 是旧的
      const freshBrief = getProject(project!.id)?.styleBrief ?? project!.styleBrief ?? ''
      const findings = [...writes].flatMap(([path, content]) =>
        lintArtifact(path, content, freshBrief)
      )
      // 编译错误也走 lint 回流。tools 模式写入时已经当轮提醒过,这里是最后防线;
      // markers 模式(单发无工具)则只有这一条路能在下一轮把"预览白屏"讲给模型听
      for (const [path, content] of writes) {
        const error = compileProbe(path, content)
        if (error) {
          findings.unshift({
            rule: 'compile-error',
            severity: 'P0',
            message: `${path} 编译失败,预览白屏:${error}`,
            fix: '先修编译错误再谈其他改动;跑不起来的设计稿用户什么都看不到。'
          })
        }
      }
      if (findings.length) recordLint(project!.id, result.artifactId, findings)
    }

    // 顺序:解说 → 问答 → 文件。回放时不完全等于流式当时的先后,但
    // 解说是整轮累计成一块的,本来也没法精确还原交错位置
    const parts: MessagePart[] = []
    if (narration) parts.push({ type: 'text', text: narration })
    parts.push(...questionParts)
    for (const path of writes.keys()) parts.push({ type: 'file', path, action: 'write' })
    for (const path of deletes) parts.push({ type: 'file', path, action: 'delete' })

    updateMessage(assistantMessage.id, {
      parts,
      status: result.status,
      ...(result.usage ? { usage: result.usage } : {}),
      ...(result.artifactId ? { artifactId: result.artifactId } : {})
    })
  }

  return {
    streamId,
    userMessageId: userMessage.id,
    assistantMessageId: assistantMessage.id,
    ...(grantedRoots.length ? { grantedRoots } : {})
  }
}

export function abortChat(streamId: string): void {
  running.get(streamId)?.abort()
}

/**
 * 从用户这句话里识别本地路径并授权。
 *
 * 用户把路径打进对话框,和在弹框里选目录一样是明确的意思表示,所以直接
 * 授权而不再多问一次。授权结果会出现在工作台的目录列表里,随时可撤销。
 */
function autoGrant(scope: RootScope, hits: { path: string }[]): WorkspaceRoot[] {
  const added: WorkspaceRoot[] = []
  for (const hit of hits) {
    try {
      added.push(addRoot(scope, hit.path))
    } catch {
      // 权限不足之类的问题不该让整轮对话发不出去
    }
  }
  return added
}

type ImagePart = Extract<MessagePart, { type: 'image' }>

/** 附件元数据 → 消息分片。字节不在这里读,sendChat 是同步的 */
function toImageParts(attachments: { assetId: string; name: string }[]): ImagePart[] {
  const parts: ImagePart[] = []
  for (const item of attachments) {
    const row = getAssetRecord(item.assetId)
    if (!row) continue
    parts.push({ type: 'image', assetId: row.id, mime: row.mime, name: item.name })
  }
  return parts
}

/** 读出像素喂给模型。取不到的静默跳过——一张图坏掉不该让整轮发不出去 */
async function loadAttachmentBytes(
  parts: ImagePart[]
): Promise<{ type: 'image'; image: Buffer; mediaType: string }[]> {
  const out: { type: 'image'; image: Buffer; mediaType: string }[] = []
  for (const part of parts) {
    const resolved = await resolveAsset(part.assetId)
    if (!resolved) continue
    out.push({ type: 'image', image: resolved.data, mediaType: resolved.mime })
  }
  return out
}

/**
 * view_image 的白名单:本会话出现过的参考图。
 *
 * 不允许模型拿任意 asset id 来试探——那等于开了一个读任意本地资源的口子。
 */
function knownImages(
  priorMessages: Message[],
  attachments: ImagePart[]
): { assetId: string; name: string; description?: string }[] {
  const seen = new Map<string, { assetId: string; name: string; description?: string }>()
  for (const message of priorMessages) {
    for (const part of message.parts) {
      if (part.type !== 'image') continue
      seen.set(part.assetId, {
        assetId: part.assetId,
        name: part.name,
        description: part.description
      })
    }
  }
  for (const part of attachments) {
    seen.set(part.assetId, { assetId: part.assetId, name: part.name })
  }
  return [...seen.values()]
}

/**
 * note_image 的落库:把描述写回图片所在的那条消息。
 *
 * 图片可能来自很早以前的某一轮,所以要全会话找一遍。写回之后,后面每一轮
 * 的 buildHistory 都会带上这句描述,多数情况下模型就不用再调 view_image 了。
 */
function noteImage(conversationId: string, assetId: string, description: string): void {
  for (const message of listMessages(conversationId)) {
    if (!message.parts.some((p) => p.type === 'image' && p.assetId === assetId)) continue
    const parts = message.parts.map((p) =>
      p.type === 'image' && p.assetId === assetId ? { ...p, description } : p
    )
    updateMessage(message.id, { parts })
    return
  }
}
