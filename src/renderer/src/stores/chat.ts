import { defineStore } from 'pinia'
import type {
  AskUserAnswer,
  ChatStreamEvent,
  ChatUsage,
  Message,
  Project,
  ProjectSettings,
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
}

/**
 * 一次工具调用在界面上的样子。
 *
 * **只活在内存里,不落库。** 事后用户关心的是结果(改了哪些文件),那个
 * 已经存在 parts 里了;调用流水是过程性的,存下来只会让 parts 膨胀,
 * buildHistory 还得额外过滤。代价是重开项目看不到当时的过程。
 */
export interface ToolActivity {
  callId: string
  toolName: string
  label: string
  state: 'running' | 'ok' | 'error'
  summary?: string
}

export const useChatStore = defineStore('chat', {
  state: () => ({
    conversationId: '' as string,
    messages: [] as Message[],
    /** 当前进行中的流(一期同一时刻只允许一个) */
    stream: null as StreamState | null,
    error: '' as string,
    /** 当前项目 id。选择要按项目存,存的时候得知道存给谁 */
    projectId: '' as string,
    /** 工作台模型选择。跟着项目走,进项目时从 project.settings 恢复 */
    selected: null as { providerId: string; modelId: string } | null,
    /**
     * 本会话启用的 MCP 服务 / 技能。null 表示"没选过,跟随全局启用状态";
     * 空数组表示用户**明确一个都不要**——两者不能混同,否则"全部取消勾选"
     * 一重启就被当成没选过,又给勾回来了。
     */
    mcpIds: null as string[] | null,
    skillIds: null as string[] | null,
    /**
     * 本轮是否联网。**按轮次生效,不持久化** ——用户点亮它是"这句话要联网"
     * 的即时决定;做成持久设置会出现"上周开过、今天忘了它还开着",然后每句
     * 闲聊都在偷偷发请求。
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
    streaming(state): boolean {
      return state.stream != null
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
    },

    /** 合并写回。失败只记日志——记不住选择不该打断用户干活 */
    persistSettings(patch: ProjectSettings): void {
      if (!this.projectId) return
      window.api.project.saveSettings(this.projectId, patch).catch((e) => {
        console.error('[chat] 保存工作台选择失败:', e)
      })
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
    openChat(conversationId: string): void {
      if (this.projectId === '' && this.conversationId === conversationId) return
      this.projectId = ''
      this.selected = null
      this.skillIds = null
      this.mcpIds = null
      this.webSearch = false
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
    },

    /** 进入工作台时调用。重复调用只在会话变化时重新拉取 */
    async openConversation(conversationId: string): Promise<void> {
      this.ensureSubscribed()
      if (this.conversationId === conversationId) return
      this.conversationId = conversationId
      this.messages = await window.api.chat.listMessages(conversationId)
      // 活动流水是内存态,换会话就没意义了
      this.activities = {}
      this.reasoning = {}
      this.error = ''
    },

    ensureSubscribed(): void {
      if (this.unsubscribe) return
      this.unsubscribe = window.api.chat.onStream((event) => this.handleEvent(event))
    },

    handleEvent(event: ChatStreamEvent): void {
      if (event.streamId !== this.stream?.streamId) return
      const message = this.messages.find((m) => m.id === this.stream?.assistantMessageId)
      if (!message) return

      // 文件相关事件同步转发给 artifact store(文件树 + 代码视图)
      useArtifactStore().applyStreamEvent(event)

      switch (event.type) {
        case 'delta': {
          const last = message.parts[message.parts.length - 1]
          if (last?.type === 'text') last.text += event.text
          else message.parts.push({ type: 'text', text: event.text })
          break
        }
        case 'file-start': {
          if (!message.parts.some((p) => p.type === 'file' && p.path === event.path)) {
            message.parts.push({ type: 'file', path: event.path, action: 'write' })
          }
          break
        }
        case 'file-patch': {
          // 工具协议没有 file-start,改动文件的气泡条目在这里补上
          if (!message.parts.some((p) => p.type === 'file' && p.path === event.path)) {
            message.parts.push({ type: 'file', path: event.path, action: 'write' })
          }
          break
        }
        case 'question': {
          // 主进程的工具循环正停在这一步等作答
          message.parts.push({
            type: 'question',
            questionId: event.questionId,
            ask: event.ask,
            answer: null
          })
          this.pendingQuestionId = event.questionId
          break
        }
        case 'file-delete': {
          message.parts.push({ type: 'file', path: event.path, action: 'delete' })
          break
        }
        case 'tool-start': {
          const list = (this.activities[message.id] ??= [])
          list.push({
            callId: event.callId,
            toolName: event.toolName,
            label: event.label,
            state: 'running'
          })
          break
        }
        case 'tool-update': {
          const hit = this.activities[message.id]?.find((a) => a.callId === event.callId)
          if (hit) hit.label = event.label
          break
        }
        case 'tool-end': {
          const hit = this.activities[message.id]?.find((a) => a.callId === event.callId)
          if (hit) {
            hit.state = event.ok ? 'ok' : 'error'
            hit.summary = event.summary
          }
          break
        }
        case 'reasoning': {
          this.reasoning[message.id] = (this.reasoning[message.id] ?? '') + event.text
          break
        }
        case 'usage': {
          message.usage = event.usage as ChatUsage
          break
        }
        case 'done': {
          message.status = 'complete'
          message.artifactId = event.artifactId
          this.stream = null
          this.pendingQuestionId = ''
          break
        }
        case 'error': {
          message.status = 'error'
          // 出错前已经改好的部分照样成了版本(工具调用是原子的),认下来,
          // 否则用户看到报错就以为这一轮白干了
          if (event.artifactId) message.artifactId = event.artifactId
          this.error = event.message
          this.stream = null
          this.pendingQuestionId = ''
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
          // null 表示渲染层还没初始化勾选状态,交给主进程按"全局启用"兜底
          ...(this.skillIds ? { skillIds: [...this.skillIds] } : {}),
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
      this.messages.push({
        id: result.assistantMessageId,
        conversationId: this.conversationId,
        role: 'assistant',
        parts: [],
        status: 'streaming',
        usage: null,
        providerSlug: null,
        modelId: this.selected.modelId,
        artifactId: null,
        createdAt: new Date().toISOString()
      })
      this.stream = {
        streamId: result.streamId,
        conversationId: this.conversationId,
        assistantMessageId: result.assistantMessageId
      }
    },

    async abort(): Promise<void> {
      if (!this.stream) return
      await window.api.chat.abort(this.stream.streamId)
      const message = this.messages.find((m) => m.id === this.stream?.assistantMessageId)
      if (message && message.status === 'streaming') message.status = 'aborted'
      this.stream = null
      this.pendingQuestionId = ''
    }
  }
})
