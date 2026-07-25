import { randomUUID } from 'crypto'
import { parsePartialJson, stepCountIs, streamText } from 'ai'
import type { WebContents } from 'electron'
import type {
  ChatStreamEvent,
  Message,
  MessagePart,
  SendChatInput,
  SendChatResult,
  Skill,
  WorkspaceRoot
} from '../../shared/types'
import { getModel } from '../db/repo/model'
import { getProviderRowById } from '../db/repo/provider'
import { createMessage, listMessages, updateMessage } from '../db/repo/message'
import { listSkills } from '../db/repo/skill'
import { readConfig } from '../config'
import { autoTitle, getConversation, touchConversation } from '../db/repo/conversation'
import { getProject, touchProject } from '../db/repo/project'
import { createArtifactVersion, getArtifactFiles, latestArtifact } from '../db/repo/artifact'
import { buildHistory } from './context'
import { buildSystemPrompt } from './prompts'
import { buildChatPrompt } from './prompts/chat'
import { buildTimeTools } from './time-tools'
import { scanSkills, skillRoots } from '../skills/scan'
import { skillCatalog } from '../skills/catalog'
import { buildSkillTools } from '../skills/tools'
import { buildWebTools } from '../web/tools'
import { closeBrowserSession } from '../web/session'
import { FileStreamParser } from './file-stream-parser'
import { SessionVfs } from './session-vfs'
import { buildFileTools } from './tools'
import { buildAskUserTool, releaseQuestions } from './ask-user'
import { buildImageTools } from './image-tools'
import { buildLocalTools, localScopePrompt } from './local-tools'
import { addRoot, listRoots } from '../workspace/roots'
import type { RootScope } from '../workspace/roots'
import { pendingPreviewError, previewErrorPrompt } from '../preview/errors'
import { detectPaths } from '../workspace/detect'
import { labelFor, summarize, verbOf } from './tool-activity'
import { errorMessage, getLanguageModel } from './registry'
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

/** 单回合内的工具调用步数上限,防跑飞 */
const MAX_STEPS = 24

/**
 * OpenAI 协议的兼容参数。
 *
 * 两个开关的取舍都在 AppConfig 的注释里。这里只强调一点:**默认值是按
 * "面对一个能力未知的中转站"来选的**,不是按直连 OpenAI 选的——后者的
 * 默认(store=true)恰恰是中转站下最容易出问题的配置。
 */
function openaiCompatOptions(): Record<string, string[] | boolean> {
  const { store, encryptedReasoning } = readConfig().openaiCompat
  return {
    store,
    // include 只在开关打开时才出现在请求体里。传一个空数组也是"发了这个
    // 字段",而不认识它的后端照样可能翻车
    ...(encryptedReasoning ? { include: ['reasoning.encrypted_content'] } : {})
  }
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
  // 本会话勾选的技能。之前这一整套(导入 / 面板 / 勾选)只做到 UI,
  // 内容从来没进过 system prompt——这是那条断掉的链路
  const enabledSkills = pickSkills(input.skillIds)
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
  const fileSkills = scanSkills()
  const roots = [...userRoots, ...skillRoots(fileSkills)]
  // 上一版预览跑挂了的话,这一轮先让模型知道。纯聊天没有预览
  const previewError = project
    ? previewErrorPrompt(pendingPreviewError(project.id, base?.id ?? null))
    : ''

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

  const emit = (event: ChatStreamEvent): void => {
    if (!sender.isDestroyed()) sender.send('chat:stream', event)
  }

  const useTools = model.abilities.includes('tools')
  const canSeeImages = model.abilities.includes('vision')
  const vfs = new SessionVfs(currentFiles)
  const parser = new FileStreamParser()
  /** tools 路的解说自己累计;markers 路用 parser.narration */
  let toolNarration = ''
  /** 本回合的问答,按发生顺序;finalize 时连答案一起存进消息 */
  const questionParts: Extract<MessagePart, { type: 'question' }>[] = []
  /** 工具入参是逐字到达的,按 callId 攒着,边攒边算展示标签 */
  const toolInputs = new Map<string, { toolName: string; json: string; label: string }>()

  const relay = (events: ReturnType<FileStreamParser['push']>): void => {
    for (const e of events) {
      switch (e.type) {
        case 'text':
          emit({ streamId, type: 'delta', text: e.text })
          break
        case 'file-start':
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

  void run()

  async function run(): Promise<void> {
    try {
      const tools = useTools
        ? {
            // 设计稿的文件工具只给设计会话。纯聊天没有产物,给了它反而会
            // 去"写文件",写到一个谁也看不见的 VFS 里
            ...(project
              ? buildFileTools(vfs, {
                  onPatch: (patch) =>
                    emit({
                      streamId,
                      type: 'file-patch',
                      path: patch.path,
                      oldText: patch.oldText,
                      newText: patch.newText,
                      ...(patch.replaceAll ? { replaceAll: true } : {})
                    }),
                  onDelete: (path) => emit({ streamId, type: 'file-delete', path })
                })
              : {}),
            // 无条件内置:模型对"今天是几号"只有训练截止时的印象,而且它
            // 意识不到这一点——不给它这个,涉及日期的输出会自信地错
            ...buildTimeTools(),
            ...buildSkillTools(fileSkills),
            ...buildWebTools(input.webSearch === true, streamId),
            ...buildAskUserTool({
              streamId,
              signal: abort.signal,
              emit: (questionId, ask) => emit({ streamId, type: 'question', questionId, ask }),
              onAnswered: (questionId, ask, answer) =>
                questionParts.push({ type: 'question', questionId, ask, answer })
            }),
            ...buildLocalTools(roots, { canSeeImages, intent: input.text }),
            ...buildImageTools({
              assets: knownImages(priorMessages, attachments),
              onNote: (assetId, description) =>
                noteImage(input.conversationId, assetId, description)
            })
          }
        : undefined

      // 技能目录两种模式都给:它只是"有什么可用",不预设任何行为
      const catalog = useTools ? skillCatalog(fileSkills, model!.contextWindow) : ''
      const system = project
        ? buildSystemPrompt(project, currentFiles, {
            mode: useTools ? 'tools' : 'markers',
            skills: enabledSkills,
            localScope: localScopePrompt(userRoots, detected.missing),
            previewError,
            skillCatalog: catalog
          })
        : buildChatPrompt({
            skills: enabledSkills,
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
        ...(tools ? { tools, stopWhen: stepCountIs(MAX_STEPS) } : {})
      })

      // 用 fullStream 而不是 textStream:后者只吐模型的文字,而工具协议下
      // 模型调工具的那几十秒根本不产文字——聊天框就是死的。工具的生命
      // 周期事件都在 fullStream 里
      //
      // 但两者的**错误语义不一样**:textStream 出错会 reject,fullStream 是
      // 把错误当成一个 part 发出来,然后流正常结束。所以下面的 catch 对它
      // 无效,必须显式接住 'error' ——否则上游 502 之类的失败会被静默吞掉,
      // 表现成"聊到一半自己停了,什么都不说"。
      let streamError: unknown = null
      for await (const part of result.fullStream) {
        if (part.type === 'error') {
          streamError = part.error
          break
        }
        // 模型侧主动中止(不是用户点的停):当成中止而非报错
        if (part.type === 'abort') break
        switch (part.type) {
          case 'text-delta': {
            if (useTools) {
              toolNarration += part.text
              emit({ streamId, type: 'delta', text: part.text })
            } else {
              relay(parser.push(part.text))
            }
            break
          }
          case 'reasoning-delta': {
            emit({ streamId, type: 'reasoning', text: part.text })
            break
          }
          case 'tool-input-start': {
            const label = verbOf(part.toolName)
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
            const parsed = await parsePartialJson(entry.json)
            const next = labelFor(entry.toolName, parsed.value as Record<string, unknown>)
            if (next !== entry.label) {
              entry.label = next
              emit({ streamId, type: 'tool-update', callId: part.id, label: next })
            }
            break
          }
          case 'tool-call': {
            const label = labelFor(part.toolName, part.input as Record<string, unknown>)
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
            emit({ streamId, type: 'tool-end', callId: part.toolCallId, ok, summary })
            break
          }
          case 'tool-error': {
            emit({
              streamId,
              type: 'tool-end',
              callId: part.toolCallId,
              ok: false,
              summary: errorMessage(part.error)
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

      if (!useTools) {
        relay(parser.finish())
        // markers 路的产出灌进同一个 VFS,落库出口只有一个
        vfs.ingest(parser.files, parser.deleted)
      }

      // 触顶 stepCountIs 说明模型还没收手,按中止处理并在解说里交代
      const cappedOut =
        useTools &&
        (await result.finishReason) === 'tool-calls' &&
        (await result.steps).length >= MAX_STEPS

      const usage = await result.usage
      if (cappedOut) {
        const note = `\n\n(已达单轮工具调用上限 ${MAX_STEPS} 步,先停在这里。改动已保存,可以继续让我接着改。)`
        toolNarration += note
        emit({ streamId, type: 'delta', text: note })
      }
      finalize(cappedOut ? 'aborted' : 'complete', {
        inputTokens: usage.inputTokens ?? 0,
        outputTokens: usage.outputTokens ?? 0
      })
    } catch (err) {
      if (!useTools) {
        relay(parser.finish())
        vfs.ingest(parser.files, parser.deleted)
      }
      if (abort.signal.aborted) {
        // 中止不算错误:已执行的工具调用 / 已解析完成的文件照常成版本
        finalize('aborted', null)
      } else {
        const artifactId = finalize('error', null)
        emit({ streamId, type: 'error', message: errorMessage(err), artifactId })
      }
    } finally {
      // 还挂着的提问一律按跳过放掉,否则那个 Promise 永远不 resolve
      releaseQuestions(streamId)
      // 无头窗口不会自己消失,漏一次就常驻一个隐藏的渲染进程——
      // 用户只会看到内存莫名其妙涨上去
      closeBrowserSession(streamId)
      running.delete(streamId)
    }
  }

  /** @returns 本轮落库的版本 id,没有改动则为 null */
  function finalize(
    status: 'complete' | 'aborted' | 'error',
    usage: { inputTokens: number; outputTokens: number } | null
  ): string | null {
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

    let artifactId: string | null = null
    // 纯聊天没有产物这个概念,连判断都不用做
    if (!isChat && keepWork && vfs.hasChanges) {
      const artifact = createArtifactVersion({
        projectId: project!.id,
        messageId: assistantMessage.id,
        baseArtifactId: base?.id ?? null,
        writes,
        deletes,
        summary: narration.slice(0, 200)
      })
      artifactId = artifact.id
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
      status,
      ...(usage ? { usage } : {}),
      ...(artifactId ? { artifactId } : {})
    })

    if (status !== 'error') {
      if (usage) emit({ streamId, type: 'usage', usage })
      emit({ streamId, type: 'done', messageId: assistantMessage.id, artifactId })
    }
    return artifactId
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
 * 取出本会话要用的技能。
 *
 * skillIds 缺省(渲染层还没初始化过勾选状态)时退回"全局启用的那些",
 * 与技能面板里的默认勾选行为一致。
 */
function pickSkills(skillIds: string[] | undefined): Skill[] {
  const all = listSkills()
  if (!skillIds) return all.filter((s) => s.enabled)
  const wanted = new Set(skillIds)
  return all.filter((s) => wanted.has(s.id))
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
