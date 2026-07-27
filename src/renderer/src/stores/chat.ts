import { defineStore } from 'pinia'
import type {
  AskUserAnswer,
  Conversation,
  ChatStreamEvent,
  ChatUsage,
  Message,
  MessagePart,
  Project,
  SessionSettings,
  RootScope,
  SendChatResult,
  WorkspaceRoot
} from '@shared/types'
import { useArtifactStore } from './artifact'
import { restoreModelChoice } from './selection'

/**
 * 把答案摊成纯数据。
 *
 * IPC 走的是 structured clone,克隆不了 Vue 的响应式 Proxy——直接传会抛
 * "An object could not be cloned",而且报错点在 store,离真正漏出代理的
 * 那个 computed 很远。调用方本来就该传普通对象,这里再兜一道。
 */
function toPlainAnswer(answer: AskUserAnswer): AskUserAnswer {
  return {
    selections: answer.selections.map((picked) => [...picked]),
    ...(answer.notes ? { notes: answer.notes } : {}),
    ...(answer.skipped ? { skipped: true } : {})
  }
}

/** 正文已经写了多少字。工具活动按它记录自己发生在哪一句之后 */
function textLength(parts: readonly MessagePart[]): number {
  return parts.reduce((n, part) => (part.type === 'text' ? n + part.text.length : n), 0)
}

/** Composer 里待发送的参考图 */
export interface ChatAttachment {
  assetId: string
  name: string
  mime: string
  uri: string
  width?: number
  height?: number
}

/**
 * 对话状态。整个应用唯一的 chat:stream 订阅者:
 * 按 streamId 路由事件,delta 拼到对应 assistant 消息上,
 * file-* 事件转发给 artifact store(M4 接入)。
 */

interface StreamState {
  streamId: string
  conversationId: string
  assistantMessageId: string
  /** 设计会话所属的项目。首页项目卡片靠它显示"生成中"转圈;纯聊天没有 */
  projectId?: string
  /**
   * 流式缓冲:这条流**从第一个分片起的全部内容**,跟着流走,不跟着"当前
   * 打开哪条会话"走。
   *
   * 增量事件不落库(完成时才整体写入 messages 表),之前把增量直接写进
   * 当前消息列表的消息对象里——切走会话,消息数组被换掉,已经流出来的
   * 内容就全丢了。现在事件一律写进这里;消息对象的 parts、activities 与
   * 缓冲**共享同一份引用**:在看着的时候增量实时上屏,切走了缓冲继续攒,
   * 切回来把消息重新指向缓冲,一个分片都不少。
   */
  parts: MessagePart[]
  activities: ToolActivity[]
  reasoning: string
}

/**
 * 一次工具调用在界面上的样子。
 *
 * **只活在内存里,不落库。** 事后用户关心的是结果(改了哪些文件),那个
 * 已经存在 parts 里了;调用流水是过程性的,存下来只会让 parts 膨胀,
 * buildHistory 还得额外过滤。代价是重开项目看不到当时的过程。
 */
/**
 * 相位:preparing 是模型在生成参数,executing 才是本地在干活。
 * 终态四分——可恢复失败(黄)和最终失败(红)在界面上必须长得不一样。
 */
export type ToolActivityState =
  'preparing' | 'executing' | 'success' | 'recoverable_error' | 'fatal_error' | 'aborted'

/** 还在进行中(转圈)的相位 */
export function isActiveToolState(state: ToolActivityState): boolean {
  return state === 'preparing' || state === 'executing'
}

export interface ToolActivity {
  callId: string
  toolName: string
  label: string
  state: ToolActivityState
  summary?: string
  /** 本地执行耗时;超过 500ms 界面才显示性能提示 */
  execMs?: number
  /**
   * 这次调用发起时,正文已经写到第几个字。
   *
   * 渲染层据此把工具活动插回正文里对应的位置(见 components/message-segments.ts)
   * ——工具活动不落库,没有别的办法恢复"先说了什么再调的工具"。缺省表示未知
   * (从库里重新加载的老消息),按"发生在末尾"处理。
   */
  afterChars?: number
}

export const useChatStore = defineStore('chat', {
  state: () => ({
    conversationId: '' as string,
    messages: [] as Message[],
    /**
     * 进行中的流,**按会话隔离**(key = conversationId)。
     *
     * 之前是全局单例,后果:在纯聊天里发了消息,切到设计项目,输入框也显示
     * "停止中"——那是别的会话在生成。每条会话的生成状态只属于它自己,
     * 不同会话可以同时各跑一条流(主进程本来就按 streamId 支持多路)。
     */
    streams: {} as Record<string, StreamState>,
    error: '' as string,
    /** 当前项目 id。选择要按项目存,存的时候得知道存给谁 */
    projectId: '' as string,
    /** 工作台模型选择。跟着项目走,进项目时从 project.settings 恢复 */
    selected: null as { providerId: string; modelId: string } | null,
    /**
     * 本会话勾选的 MCP 服务名 / 技能名(身份即名字,没有数据库 id)。
     * null 表示"没选过",效果与空数组相同:**什么都不加载**——技能与 MCP
     * 都是手动勾选制,不存在"按全局启用兜底"。
     */
    mcpIds: null as string[] | null,
    skillIds: null as string[] | null,
    /**
     * 是否联网。**按会话记忆**:和模型/技能一样进 settings,重开这条会话
     * 还保持原样——但只按会话不按全局,避免"上周在别的会话开过、今天每句
     * 闲聊都在偷偷发请求"。
     */
    webSearch: false,
    /** 正在等用户作答的提问 id;主进程的工具循环停在那一步 */
    pendingQuestionId: '' as string,
    /** 按 assistant 消息 id 存的工具活动流水(内存态) */
    activities: {} as Record<string, ToolActivity[]>,
    /** 按 assistant 消息 id 存的思考流(内存态) */
    reasoning: {} as Record<string, string>,
    /**
     * 最近一次发送时从消息里自动识别并授权的本地路径。
     * 工作台的目录列表监听它,让用户立刻看见自己那句话放开了什么。
     */
    lastGrantedRoots: [] as WorkspaceRoot[],
    unsubscribe: null as (() => void) | null
  }),

  getters: {
    /**
     * 本地授权的归属范围。
     *
     * 设计会话跟着项目走,纯聊天跟着这次会话走——聊天没有项目,授权只在这条
     * 聊天里有效,删掉聊天就一起回收。组件不需要知道自己在哪种模式下,拿这个
     * 就行。
     */
    rootScope(state): RootScope | null {
      if (state.projectId) return { projectId: state.projectId }
      if (state.conversationId) return { conversationId: state.conversationId }
      return null
    },
    /** 只看**当前打开的会话**在不在生成。别的会话在后台跑不关这里的事 */
    streaming(state): boolean {
      return state.streams[state.conversationId] != null
    },
    awaitingAnswer(state): boolean {
      return state.pendingQuestionId !== ''
    }
  },

  actions: {
    /**
     * 进入项目时恢复"上次选了什么"。
     *
     * 无条件覆盖三个字段(哪怕存档是空的),不能写成"存档有值才填":
     * 这些字段在 store 里是跨项目共用的一份,换项目时若不清空,上一个
     * 项目的模型和技能会静默漏到下一个项目里。
     */
    openProject(project: Project): void {
      if (this.projectId === project.id) return
      this.projectId = project.id

      const saved = project.settings
      this.selected = restoreModelChoice(saved)
      this.skillIds = saved?.skillIds ?? null
      this.mcpIds = saved?.mcpIds ?? null
      this.webSearch = saved?.webSearch ?? false
    },

    /**
     * 合并写回。按模式路由:设计会话存到项目上,纯聊天存到这条会话上。
     *
     * 两种模式共用同一套选择器组件,所以归属判断只能放在这里——放到组件里
     * 就得每个组件都判一次,漏一个就是"这个设置记不住"。
     *
     * 失败只记日志:记不住选择不该打断用户干活。
     */
    persistSettings(patch: SessionSettings): void {
      const save = this.projectId
        ? window.api.project.saveSettings(this.projectId, patch)
        : this.conversationId
          ? window.api.chatSession.saveSettings(this.conversationId, patch)
          : null
      save?.catch((e) => console.error('[chat] 保存选择失败:', e))
    },

    /** 联网开关。和技能一样要记住,否则每开一条会话都要重新点 */
    setWebSearch(on: boolean): void {
      this.webSearch = on
      this.persistSettings({ webSearch: on })
    },

    /**
     * @param persist 只有**用户亲自选的**才写回。模型不可用时的自动兜底
     *        不写——供应商只是临时停用的话,回头启用了还能恢复成他原来选的
     */
    selectModel(providerId: string, modelId: string, persist = true): void {
      this.selected = { providerId, modelId }
      if (persist) this.persistSettings({ providerId, modelId })
    },

    setSkillIds(ids: string[]): void {
      this.skillIds = ids
      this.persistSettings({ skillIds: ids })
    },

    setMcpIds(ids: string[]): void {
      this.mcpIds = ids
      this.persistSettings({ mcpIds: ids })
    },

    /**
     * 进入纯聊天时调用。
     *
     * 和 openProject 对称:那边从 project.settings 恢复选择,这边**清空** ——
     * 聊天没有项目级设置,而 store 里那三个字段是跨模式共用的一份,不清的话
     * 上一个项目的模型和技能会漏进聊天里。
     */
    openChat(conversation: Conversation | null): void {
      this.projectId = ''

      // 无条件覆盖,哪怕存档是空的:这几个字段在 store 里是跨会话共用的一份,
      // 不清的话上一条聊天(或上一个项目)的选择会静默漏到这一条里
      const saved = conversation?.settings ?? null
      this.selected = restoreModelChoice(saved)
      this.skillIds = saved?.skillIds ?? null
      this.mcpIds = saved?.mcpIds ?? null
      this.webSearch = saved?.webSearch ?? false
    },

    /**
     * 回到"还没选会话"的状态(聊天首页)。
     *
     * 不建空会话就是这个状态存在的意义:用户点"新对话"只是想开个头,真到
     * 发出第一句才落库。否则每点一次就在列表里留一条永远空着的记录。
     */
    closeConversation(): void {
      this.conversationId = ''
      this.messages = []
      this.activities = {}
      this.reasoning = {}
      this.error = ''
    },

    /**
     * 确保聊天模式下有一条会话可用。
     *
     * 起始页是**故意不建会话**的(见 closeConversation),但附件和目录授权都
     * 需要一个归属——用户往起始页拖一个文件时不该静默无反应。所以这类动作
     * 先调这个:到那一刻会话才真的落库。
     *
     * 设计工作台里 projectId 非空,直接返回,不受影响。
     */
    async ensureChat(): Promise<void> {
      if (this.projectId || this.conversationId) return
      const created = await window.api.chatSession.create()
      await this.openConversation(created.id)

      /*
       * 补写起始页里做的选择。起始页故意不建会话,那时 persistSettings 找不到
       * 归属只能丢弃——模型/技能/MCP/联网都选了个寂寞,重开这条会话全没了。
       * 会话落库的这一刻把内存里的现状整体写进去,起始页的选择才真正生效。
       */
      const patch: SessionSettings = {
        ...(this.selected ?? {}),
        ...(this.skillIds ? { skillIds: [...this.skillIds] } : {}),
        ...(this.mcpIds ? { mcpIds: [...this.mcpIds] } : {}),
        ...(this.webSearch ? { webSearch: true } : {})
      }
      if (Object.keys(patch).length > 0) this.persistSettings(patch)
    },

    /** 进入工作台时调用。重复调用只在会话变化时重新拉取 */
    async openConversation(conversationId: string): Promise<void> {
      this.ensureSubscribed()
      if (this.conversationId === conversationId) return
      this.conversationId = conversationId
      this.messages = await window.api.chat.listMessages(conversationId)
      // 活动流水是内存态,换会话就没意义了;提问归属于上一条会话,一并放掉
      this.activities = {}
      this.reasoning = {}
      this.error = ''
      this.pendingQuestionId = ''

      /*
       * 这条会话有流在后台跑:库里那条 assistant 消息还是空的(增量完成时
       * 才落库),把它重新接回流缓冲——缓冲里存着从第一个分片起的全部内容
       * (文本、文件条目、工具活动、思考流),接上之后增量继续实时上屏。
       */
      const active = this.streams[conversationId]
      if (active) {
        const message = this.messages.find((m) => m.id === active.assistantMessageId)
        if (message) {
          message.parts = active.parts
          message.status = 'streaming'
        }
        this.activities[active.assistantMessageId] = active.activities
        this.reasoning[active.assistantMessageId] = active.reasoning
        // 流正停在一个没答的提问上:回来接着答,别让主进程干等
        const pending = [...active.parts]
          .reverse()
          .find((p) => p.type === 'question' && p.answer === null)
        if (pending?.type === 'question') this.pendingQuestionId = pending.questionId
      }
    },

    ensureSubscribed(): void {
      if (this.unsubscribe) return
      this.unsubscribe = window.api.chat.onStream((event) => this.handleEvent(event))
    },

    handleEvent(event: ChatStreamEvent): void {
      const entry = Object.values(this.streams).find((s) => s.streamId === event.streamId)
      if (!entry) return
      const isCurrent = entry.conversationId === this.conversationId

      // 画布(文件树 + 代码视图)只属于当前会话,别的会话的文件事件不转发
      if (isCurrent) useArtifactStore().applyStreamEvent(event)

      /*
       * 内容增量一律写进流缓冲 entry.parts / entry.activities——它们和当前
       * 会话的消息对象共享引用(见 StreamState 注释),在看着的时候实时上屏,
       * 切走了也一个分片不丢。只有"消息级状态"(status/usage/artifactId)
       * 和"全局提示"(pendingQuestionId/error)按 isCurrent 分流:后台会话
       * 的这些状态由落库兜底,切回来从库里读到的就是对的。
       */
      switch (event.type) {
        case 'delta': {
          const last = entry.parts[entry.parts.length - 1]
          if (last?.type === 'text') last.text += event.text
          else entry.parts.push({ type: 'text', text: event.text })
          break
        }
        // 工具协议里改动文件的气泡条目靠 file-patch 补,两种事件同一处理
        case 'file-start':
        case 'file-patch': {
          if (!entry.parts.some((p) => p.type === 'file' && p.path === event.path)) {
            entry.parts.push({ type: 'file', path: event.path, action: 'write' })
          }
          break
        }
        case 'question': {
          // 主进程的工具循环正停在这一步等作答
          entry.parts.push({
            type: 'question',
            questionId: event.questionId,
            ask: event.ask,
            answer: null
          })
          if (isCurrent) this.pendingQuestionId = event.questionId
          break
        }
        case 'file-delete': {
          entry.parts.push({ type: 'file', path: event.path, action: 'delete' })
          break
        }
        case 'tool-start': {
          entry.activities.push({
            callId: event.callId,
            toolName: event.toolName,
            label: event.label,
            state: 'preparing',
            afterChars: textLength(entry.parts)
          })
          break
        }
        case 'tool-update': {
          const hit = entry.activities.find((a) => a.callId === event.callId)
          if (hit) hit.label = event.label
          break
        }
        case 'tool-exec': {
          // 本地执行真正开始:相位翻转,标签换成"执行X"
          const hit = entry.activities.find((a) => a.callId === event.callId)
          if (hit) {
            hit.state = 'executing'
            hit.label = event.label
          }
          break
        }
        case 'tool-end': {
          const hit = entry.activities.find((a) => a.callId === event.callId)
          if (hit) {
            hit.state = event.status ?? (event.ok ? 'success' : 'recoverable_error')
            hit.summary = event.summary
            if (event.execMs !== undefined) hit.execMs = event.execMs
          }
          break
        }
        case 'reasoning': {
          entry.reasoning += event.text
          // this.reasoning 是按消息 id 的展示态,切会话会被清空;从缓冲镜像
          // 过去,回来时 openConversation 再整体恢复
          if (isCurrent) this.reasoning[entry.assistantMessageId] = entry.reasoning
          break
        }
        case 'usage': {
          const message = this.messages.find((m) => m.id === entry.assistantMessageId)
          if (message) message.usage = event.usage as ChatUsage
          break
        }
        case 'done': {
          // 流结束了还停在进行相位的活动,只可能是被打断的
          for (const a of entry.activities) {
            if (isActiveToolState(a.state)) a.state = 'aborted'
          }
          const message = this.messages.find((m) => m.id === entry.assistantMessageId)
          if (message) {
            message.status = 'complete'
            message.artifactId = event.artifactId
          }
          delete this.streams[entry.conversationId]
          if (isCurrent) this.pendingQuestionId = ''
          break
        }
        case 'error': {
          for (const a of entry.activities) {
            if (isActiveToolState(a.state)) a.state = 'aborted'
          }
          const message = this.messages.find((m) => m.id === entry.assistantMessageId)
          if (message) {
            message.status = 'error'
            // 出错前已经改好的部分照样成了版本(工具调用是原子的),认下来,
            // 否则用户看到报错就以为这一轮白干了
            if (event.artifactId) message.artifactId = event.artifactId
          }
          if (isCurrent) {
            this.error = event.message
            this.pendingQuestionId = ''
          }
          delete this.streams[entry.conversationId]
          break
        }
      }
    },

    /**
     * 提交提问的答案。
     *
     * 本地先落答案再发 IPC:主进程收到就往下跑了,不会再回一个"已收到"
     * 事件,卡片得靠这里自己切到已答态。
     */
    async answerQuestion(questionId: string, answer: AskUserAnswer): Promise<void> {
      // 摊成纯数据再往下走:IPC 是 structured clone,克隆不了响应式代理
      const plain = toPlainAnswer(answer)
      for (const message of this.messages) {
        const part = message.parts.find((p) => p.type === 'question' && p.questionId === questionId)
        if (part?.type === 'question') part.answer = plain
      }
      if (this.pendingQuestionId === questionId) this.pendingQuestionId = ''
      await window.api.chat.answerQuestion(questionId, plain)
    },

    async send(text: string, attachments: ChatAttachment[] = []): Promise<void> {
      if (!this.selected || this.streaming || (!text.trim() && attachments.length === 0)) return
      this.error = ''

      let result: SendChatResult
      try {
        result = await window.api.chat.send({
          conversationId: this.conversationId,
          text: text.trim(),
          providerId: this.selected.providerId,
          modelId: this.selected.modelId,
          ...(attachments.length
            ? { attachments: attachments.map((a) => ({ assetId: a.assetId, name: a.name })) }
            : {}),
          // 勾选的技能名与 MCP 名。没勾就什么都不传——主进程默认零加载
          ...(this.skillIds?.length ? { skillIds: [...this.skillIds] } : {}),
          ...(this.mcpIds?.length ? { mcpIds: [...this.mcpIds] } : {}),
          ...(this.webSearch ? { webSearch: true } : {})
        })
        this.lastGrantedRoots = result.grantedRoots ?? []
      } catch (err) {
        // 比如模型不支持识图——主进程给的是人话,直接显示
        this.error = err instanceof Error ? err.message : String(err)
        return
      }

      // 主进程已落库,这里按返回的 id 就地补上本地态,不用重新拉全量
      this.messages.push({
        id: result.userMessageId,
        conversationId: this.conversationId,
        role: 'user',
        parts: [
          { type: 'text', text: text.trim() },
          ...attachments.map((a) => ({
            type: 'image' as const,
            assetId: a.assetId,
            mime: a.mime,
            name: a.name,
            width: a.width,
            height: a.height
          }))
        ],
        status: 'complete',
        usage: null,
        providerSlug: null,
        modelId: null,
        artifactId: null,
        createdAt: new Date().toISOString()
      })
      // parts / activities 与流缓冲共享引用(见 StreamState 的注释)
      const parts: MessagePart[] = []
      const activities: ToolActivity[] = []
      this.messages.push({
        id: result.assistantMessageId,
        conversationId: this.conversationId,
        role: 'assistant',
        parts,
        status: 'streaming',
        usage: null,
        providerSlug: null,
        modelId: this.selected.modelId,
        artifactId: null,
        createdAt: new Date().toISOString()
      })
      this.activities[result.assistantMessageId] = activities
      this.streams[this.conversationId] = {
        streamId: result.streamId,
        conversationId: this.conversationId,
        assistantMessageId: result.assistantMessageId,
        ...(this.projectId ? { projectId: this.projectId } : {}),
        parts,
        activities,
        reasoning: ''
      }
    },

    /** 停止**当前会话**的生成。别的会话在后台跑的流不受影响 */
    async abort(): Promise<void> {
      const entry = this.streams[this.conversationId]
      if (!entry) return
      await window.api.chat.abort(entry.streamId)
      const message = this.messages.find((m) => m.id === entry.assistantMessageId)
      if (message && message.status === 'streaming') message.status = 'aborted'
      delete this.streams[entry.conversationId]
      this.pendingQuestionId = ''
    }
  }
})
