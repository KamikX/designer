import { t } from '@renderer/i18n'
import { defineStore } from 'pinia'
import type {
  Conversation,
  CreateGroupInput,
  UpdateGroupInput,
  GroupMemberTemplate,
  GroupRoleMeta,
  GroupStreamEvent,
  Message,
  MessagePart,
  Model,
  Provider
} from '@shared/types'
import { normalizeGroupMembers } from '@shared/group-members'
import { createGroupMention, firstMention } from '@shared/group-mentions'
import { groupDeliverables, type DeliverableEntry } from '@shared/group-deliverables'
import { useProviderStore } from './provider'

/**
 * 群组里一次工具调用在界面上的样子。
 *
 * 和 chat store 的 ToolActivity 一样**只活在内存里,不落库**:事后用户关心的
 * 是角色交付的文档,调用流水是过程性的。代价是重开群组看不到当时的过程。
 */
export interface GroupActivity {
  callId: string
  label: string
  /** 与 chat store 的 ToolActivityState 同构:相位 + 四种终态 */
  state: 'preparing' | 'executing' | 'success' | 'recoverable_error' | 'fatal_error' | 'aborted'
  summary?: string
  /**
   * 这次调用发起时,这条消息的正文已经写到第几个字。渲染层据此把工具活动
   * 插回正文里对应的位置(见 components/message-segments.ts)。
   */
  afterChars?: number
}

/**
 * 多 agent 协作群组的状态。整个应用唯一的 group:stream 订阅者。
 *
 * 和 chat store 的关键差别:群组的消息是**逐条落库**的(每个 agent 说完一段
 * 就写一条),所以后台群不需要流缓冲——切回去 openGroup 重拉一次库就是全的,
 * 顶多丢掉"正在流式中的那半条",下一个 delta 会把它重新补上。这里只为后台群
 * 维护一个"有没有接力在跑"的布尔,列表转圈靠它。
 */
export const useCollabStore = defineStore('collab', {
  state: () => ({
    groups: [] as Conversation[],
    /** 新群添加成员时使用的内置快捷模板。 */
    roles: [] as GroupMemberTemplate[],
    /** 当前打开的群;空串表示停在空状态引导页 */
    conversationId: '' as string,
    messages: [] as Message[],
    /** 按消息 id 的工具活动流水(内存态,换群就清) */
    activities: {} as Record<string, GroupActivity[]>,
    /**
     * agent-start 带来的完整注入提示词,按消息 id 存(内存态)。
     * 头像抽屉展示用:让用户看见每个角色这一轮到底被喂了什么。
     */
    systemPrompts: {} as Record<string, string>,
    /**
     * 哪些群有接力链在跑(key = conversationId)。后台群的事件只更新这里,
     * 不碰消息——内容等切回去时从库重拉。
     */
    chaining: {} as Record<string, boolean>,
    /**
     * 当前打开的群里正在发言的人:messageId → 成员 id。
     *
     * 不能是单值:一条消息 @ 多位会并行 fan-out,同一时刻好几个人在说话。
     * 按 messageId 记还顺带修好了 delta 的乱序兜底——单值时晚到的分片会被
     * 记到"最后一个开始说话的人"身上,内容直接串到别人的消息里。
     */
    speakingByMessage: {} as Record<string, string>,
    /** 流事件里报上来的错误(发送失败的错误走 message.error,不进这里) */
    error: '' as string,
    /**
     * chain-stopped 时被拦下的成员 id:接力的三种拦停都是"有界循环"的
     * 检查点而非终点,记下 TA 让页面给一键续棒按钮。空串 = 无可续。
     */
    resumeMemberId: '' as string,
    unsubscribe: null as (() => void) | null
  }),

  getters: {
    rolesById(state): Record<string, GroupRoleMeta> {
      const group = state.groups.find((item) => item.id === state.conversationId)
      const members = normalizeGroupMembers(group?.settings?.members)
      // 当前群成员放在后面覆盖同 id 模板，新群始终展示成员自己的名称和颜色。
      return Object.fromEntries([...state.roles, ...members].map((role) => [role.id, role]))
    },
    currentGroup(state): Conversation | null {
      return state.groups.find((g) => g.id === state.conversationId) ?? null
    },
    /** 当前群的成员角色(按建群时的勾选顺序) */
    memberRoles(state): GroupRoleMeta[] {
      const group = state.groups.find((item) => item.id === state.conversationId)
      return normalizeGroupMembers(group?.settings?.members)
    },
    /** 提及输入、普通文本与 Markdown 共用的当前成员表。 */
    mentionMembers(): GroupRoleMeta[] {
      return this.memberRoles
    },
    /** 当前打开的群有没有接力在跑。别的群在后台跑不关这里的事 */
    chainingHere(state): boolean {
      return state.chaining[state.conversationId] === true
    },
    /**
     * 本轮交付清单。纯派生:内容只有 messages 一份,这里不另存状态。
     * 面板、徽标、导出用的是同一份规则(shared/group-deliverables.ts)。
     */
    deliverables(state): DeliverableEntry[] {
      return groupDeliverables(state.messages, this.memberRoles)
    },
    /** 此刻正在发言的成员 id(并行时不止一个) */
    speakingAuthors(state): string[] {
      return [...new Set(Object.values(state.speakingByMessage))]
    },
    /** 一键续棒的目标成员;成员已被移出群时返回 null,按钮随之消失 */
    resumeMember(state): GroupRoleMeta | null {
      if (!state.resumeMemberId) return null
      return this.memberRoles.find((role) => role.id === state.resumeMemberId) ?? null
    },
    /**
     * 模型选择器的数据源:只列带 tools 能力的模型。
     * 群组编排靠工具调用交接文档,不带 tools 的模型发出去必然被主进程拒绝
     * ——与其发了才报错,不如根本不让选。
     */
    toolModels(): { provider: Provider; models: Model[] }[] {
      return useProviderStore()
        .chatModels.map(({ provider, models }) => ({
          provider,
          models: models.filter((m) => m.abilities.includes('tools'))
        }))
        .filter((group) => group.models.length > 0)
    }
  },

  actions: {
    /** 进入协作页时调用。重复调用只是重拉列表,订阅始终只有一份 */
    async init(): Promise<void> {
      this.ensureSubscribed()
      const [roles, groups] = await Promise.all([window.api.group.roles(), window.api.group.list()])
      this.roles = roles
      this.groups = groups
    },

    ensureSubscribed(): void {
      if (this.unsubscribe) return
      this.unsubscribe = window.api.group.onStream((event) => this.handleEvent(event))
    },

    async openGroup(id: string): Promise<void> {
      this.ensureSubscribed()
      this.conversationId = id
      // 消息是逐条落库的,重拉就是全的;正在流式中的半条靠后续 delta 补回
      this.messages = await window.api.group.messages(id)
      this.activities = {}
      this.systemPrompts = {}
      this.speakingByMessage = {}
      this.error = ''
      this.resumeMemberId = ''
    },

    /** 回到空状态引导页 */
    closeGroup(): void {
      this.conversationId = ''
      this.messages = []
      this.activities = {}
      this.systemPrompts = {}
      this.speakingByMessage = {}
      this.error = ''
      this.resumeMemberId = ''
    },

    async createGroup(input: CreateGroupInput): Promise<Conversation> {
      const created = await window.api.group.create({
        name: input.name,
        members: input.members.map((member) => ({ ...member, skillIds: [...member.skillIds] }))
      })
      this.groups.unshift(created)
      return created
    },

    /** 编辑群名与成员配置。成员表读的是 groups 里的 settings,原位替换即可全局生效 */
    async updateGroup(input: UpdateGroupInput): Promise<Conversation> {
      const updated = await window.api.group.update({
        id: input.id,
        name: input.name,
        members: input.members.map((member) => ({ ...member, skillIds: [...member.skillIds] }))
      })
      this.groups = this.groups.map((g) => (g.id === updated.id ? updated : g))
      return updated
    },

    async removeGroup(id: string): Promise<void> {
      await window.api.group.remove(id)
      this.groups = this.groups.filter((g) => g.id !== id)
      delete this.chaining[id]
      if (this.conversationId === id) this.closeGroup()
    },

    /**
     * 发消息。乐观上屏再发 IPC:group.send 不返回消息 id,主进程也不会回发
     * "已收到"事件,不先上屏的话这句话要等到下次重拉才出现。
     *
     * 失败(模型不支持工具 / 上一条链还在跑)时消息没落库,撤掉乐观上屏并
     * 把错误抛给调用方——用 message.error 提示是页面的事。
     */
    async send(text: string): Promise<void> {
      const trimmed = text.trim()
      const cid = this.conversationId
      if (!trimmed || !cid || this.chainingHere) return
      this.error = ''
      this.resumeMemberId = ''

      const optimistic: Message = {
        id: `local-${Date.now()}`,
        conversationId: cid,
        role: 'user',
        parts: [{ type: 'text', text: trimmed }],
        status: 'complete',
        usage: null,
        providerSlug: null,
        modelId: null,
        artifactId: null,
        author: 'user',
        createdAt: new Date().toISOString()
      }
      this.messages.push(optimistic)

      // 主进程可能在 invoke resolve 前同步回传 error / chain-done。先标记再调用，
      // 才能让终止事件成为最后一次写入，避免 await 后把已经结束的链重新点亮。
      const startsChain = firstMention(trimmed, this.mentionMembers) !== null
      if (startsChain) this.chaining[cid] = true

      try {
        await window.api.group.send({
          conversationId: cid,
          text: trimmed
        })
      } catch (err) {
        this.messages = this.messages.filter((m) => m.id !== optimistic.id)
        if (startsChain) delete this.chaining[cid]
        throw err
      }
    },

    /**
     * 一键续棒:guard 拦停后,以一条新用户消息 @ 被拦的成员开新链。
     * 走普通 send 而不是"恢复旧链":新链的 guard 计数重置,同时留下一条
     * 可见的用户消息作为"人确认过继续"的记录。
     */
    async resumeChain(): Promise<void> {
      const target = this.resumeMember
      if (!target || this.chainingHere) return
      await this.send(t('{0} 请接着上一棒的交接继续', createGroupMention(target)))
      this.error = ''
    },

    /** 把本轮交付物导出成一份 markdown;用户取消返回 null */
    async exportDeliverables(): Promise<string | null> {
      if (!this.conversationId) return null
      return window.api.group.exportDeliverables(this.conversationId)
    },

    /** 停止当前群的接力链 */
    async abort(): Promise<void> {
      const cid = this.conversationId
      if (!cid) return
      await window.api.group.abort(cid)
      // 主进程随后还会广播 chain-done,这里先清一次让按钮立即复原
      delete this.chaining[cid]
      this.speakingByMessage = {}
      for (const m of this.messages) {
        if (m.status === 'streaming') m.status = 'aborted'
      }
    },

    /**
     * 流事件入口,按 conversationId 路由。
     *
     * 后台群只维护 chaining——内容是逐条落库的,切回去重拉即可,在这里
     * 追增量反而要为每个群都养一份缓冲,不值得。
     */
    handleEvent(event: GroupStreamEvent): void {
      const cid = event.conversationId
      if (cid !== this.conversationId) {
        // 只认 chain-done:拦停与报错都只结束**一条分支**,别的分支还在跑,
        // 这时把列表上的转圈撤掉是假的
        if (event.type === 'chain-done') delete this.chaining[cid]
        else this.chaining[cid] = true
        return
      }

      switch (event.type) {
        case 'agent-start': {
          this.chaining[cid] = true
          this.speakingByMessage[event.messageId] = event.author
          this.systemPrompts[event.messageId] = event.system
          this.activities[event.messageId] = []
          this.ensureAgentMessage(event.messageId, event.author)
          break
        }
        case 'delta': {
          // 正常时序 agent-start 先到、占位消息已在;兜一层防事件乱序。
          // 作者按 messageId 取:并行时"最后一个开始说话的人"根本不是这条的作者
          const msg = this.ensureAgentMessage(
            event.messageId,
            this.speakingByMessage[event.messageId] ?? ''
          )
          const last = msg.parts[msg.parts.length - 1]
          if (last?.type === 'text') last.text += event.text
          else msg.parts.push({ type: 'text', text: event.text })
          break
        }
        case 'tool-start': {
          const list = this.activities[event.messageId] ?? (this.activities[event.messageId] = [])
          const written = this.messages
            .find((m) => m.id === event.messageId)
            ?.parts.reduce((n, part) => (part.type === 'text' ? n + part.text.length : n), 0)
          list.push({
            callId: event.callId,
            label: event.label,
            state: 'preparing',
            ...(written === undefined ? {} : { afterChars: written })
          })
          break
        }
        case 'tool-update': {
          const hit = this.activities[event.messageId]?.find((a) => a.callId === event.callId)
          if (hit) hit.label = event.label
          break
        }
        case 'tool-exec': {
          const hit = this.activities[event.messageId]?.find((a) => a.callId === event.callId)
          if (hit) {
            hit.state = 'executing'
            hit.label = event.label
          }
          break
        }
        case 'tool-end': {
          const hit = this.activities[event.messageId]?.find((a) => a.callId === event.callId)
          if (hit) {
            hit.state = event.status ?? (event.ok ? 'success' : 'recoverable_error')
            hit.summary = event.summary
          }
          break
        }
        case 'agent-retry': {
          // 瞬时故障后这一棒从头重流:上一次的半截正文与工具流水作废,
          // 留一条流水让用户知道刚才断过、系统在自动重试
          const msg = this.messages.find((m) => m.id === event.messageId)
          if (msg) {
            msg.parts = [{ type: 'text', text: '' }]
            msg.status = 'streaming'
          }
          this.activities[event.messageId] = [
            {
              callId: `retry-${event.attempt}`,
              get label() {
                return t('连接中断,已自动重试(第 {0} 次)', event.attempt - 1)
              },
              state: 'success',
              summary: event.message
            }
          ]
          break
        }
        case 'agent-done': {
          const msg = this.messages.find((m) => m.id === event.messageId)
          if (msg?.status === 'streaming') msg.status = 'complete'
          // 只熄这一条的灯:并行的同伴可能还在说
          delete this.speakingByMessage[event.messageId]
          break
        }
        case 'chain-done': {
          delete this.chaining[cid]
          this.speakingByMessage = {}
          break
        }
        /*
         * 拦停与报错都是**分支级**的:别的分支还在跑,不能在这里把运行态清掉,
         * 否则输入框提前解锁、用户发第二条会被主进程以"上一条还在跑"顶回来。
         * 收口统一交给必然会到的 chain-done。
         */
        case 'chain-stopped': {
          this.error = event.message
          this.resumeMemberId = event.nextMemberId ?? ''
          break
        }
        case 'error': {
          if (event.messageId) {
            const msg = this.messages.find((m) => m.id === event.messageId)
            if (msg && msg.status === 'streaming') msg.status = 'error'
            delete this.speakingByMessage[event.messageId]
          }
          this.error = event.message
          break
        }
      }
    },

    /** 找到 agent 的消息;不存在(占位还没建)就先 push 一条流式空消息 */
    ensureAgentMessage(messageId: string, author: string): Message {
      const existing = this.messages.find((m) => m.id === messageId)
      if (existing) return existing
      const parts: MessagePart[] = [{ type: 'text', text: '' }]
      const placeholder: Message = {
        id: messageId,
        conversationId: this.conversationId,
        role: 'assistant',
        parts,
        status: 'streaming',
        usage: null,
        providerSlug: null,
        modelId: null,
        artifactId: null,
        author,
        createdAt: new Date().toISOString()
      }
      this.messages.push(placeholder)
      return placeholder
    }
  }
})
