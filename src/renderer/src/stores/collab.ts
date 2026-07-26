import { defineStore } from 'pinia'
import type {
  Conversation,
  CreateGroupInput,
  GroupMemberTemplate,
  GroupRoleMeta,
  GroupStreamEvent,
  Message,
  MessagePart,
  Model,
  Provider
} from '@shared/types'
import { normalizeGroupMembers } from '@shared/group-members'
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
  state: 'running' | 'ok' | 'error'
  summary?: string
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
    /** 内置快捷模板。旧群展示和新群添加成员都从这里取。 */
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
    /** 当前打开的群里正在发言的角色 id;没人发言时为空 */
    speakingAuthor: '' as string,
    /** 流事件里报上来的错误(发送失败的错误走 message.error,不进这里) */
    error: '' as string,
    /**
     * 模型选择,群组共用一份并持久化。
     *
     * 不像项目/聊天那样按会话存:群组编排要求模型必须带 tools 能力,可选面
     * 本来就窄,每个群各存一份只会让用户反复选同一个。
     */
    model: useStorage<{ providerId: string; modelId: string }>('designer:collab-model', {
      providerId: '',
      modelId: ''
    }),
    unsubscribe: null as (() => void) | null
  }),

  getters: {
    rolesById(state): Record<string, GroupRoleMeta> {
      const group = state.groups.find((item) => item.id === state.conversationId)
      const members = normalizeGroupMembers(group?.settings?.members, state.roles).map((item) =>
        item.kind === 'configured' ? item.member : item.role
      )
      // 当前群成员放在后面覆盖同 id 模板，新群始终展示成员自己的名称和颜色。
      return Object.fromEntries([...state.roles, ...members].map((role) => [role.id, role]))
    },
    currentGroup(state): Conversation | null {
      return state.groups.find((g) => g.id === state.conversationId) ?? null
    },
    /** 当前群的成员角色(按建群时的勾选顺序) */
    memberRoles(state): GroupRoleMeta[] {
      const group = state.groups.find((item) => item.id === state.conversationId)
      return normalizeGroupMembers(group?.settings?.members, state.roles).map((item) =>
        item.kind === 'configured' ? item.member : item.role
      )
    },
    /** 当前打开的群有没有接力在跑。别的群在后台跑不关这里的事 */
    chainingHere(state): boolean {
      return state.chaining[state.conversationId] === true
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
      this.speakingAuthor = ''
      this.error = ''
    },

    /** 回到空状态引导页 */
    closeGroup(): void {
      this.conversationId = ''
      this.messages = []
      this.activities = {}
      this.systemPrompts = {}
      this.speakingAuthor = ''
      this.error = ''
    },

    async createGroup(input: CreateGroupInput): Promise<Conversation> {
      const created = await window.api.group.create({
        name: input.name,
        members: input.members.map((member) => ({ ...member, skillIds: [...member.skillIds] }))
      })
      this.groups.unshift(created)
      return created
    },

    async removeGroup(id: string): Promise<void> {
      await window.api.group.remove(id)
      this.groups = this.groups.filter((g) => g.id !== id)
      delete this.chaining[id]
      if (this.conversationId === id) this.closeGroup()
    },

    selectModel(providerId: string, modelId: string): void {
      this.model = { providerId, modelId }
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

      try {
        await window.api.group.send({
          conversationId: cid,
          text: trimmed,
          fallbackModelRowId: this.model.modelId || undefined
        })
      } catch (err) {
        this.messages = this.messages.filter((m) => m.id !== optimistic.id)
        throw err
      }

      // @ 了成员才会起链;没 @ 只是留言,不会有 chain-done 来清这个标记,
      // 所以不能无条件置 true——那会让暂停按钮永远停在那里
      if (this.memberRoles.some((r) => trimmed.includes(`@${r.name}`))) {
        this.chaining[cid] = true
      }
    },

    /** 停止当前群的接力链 */
    async abort(): Promise<void> {
      const cid = this.conversationId
      if (!cid) return
      await window.api.group.abort(cid)
      // 主进程随后还会广播 chain-done,这里先清一次让按钮立即复原
      delete this.chaining[cid]
      this.speakingAuthor = ''
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
        if (event.type === 'chain-done' || event.type === 'error') delete this.chaining[cid]
        else this.chaining[cid] = true
        return
      }

      switch (event.type) {
        case 'agent-start': {
          this.chaining[cid] = true
          this.speakingAuthor = event.author
          this.systemPrompts[event.messageId] = event.system
          this.activities[event.messageId] = []
          this.ensureAgentMessage(event.messageId, event.author)
          break
        }
        case 'delta': {
          // 正常时序 agent-start 先到、占位消息已在;兜一层防事件乱序
          const msg = this.ensureAgentMessage(event.messageId, this.speakingAuthor)
          const last = msg.parts[msg.parts.length - 1]
          if (last?.type === 'text') last.text += event.text
          else msg.parts.push({ type: 'text', text: event.text })
          break
        }
        case 'tool-start': {
          const list = this.activities[event.messageId] ?? (this.activities[event.messageId] = [])
          list.push({ callId: event.callId, label: event.label, state: 'running' })
          break
        }
        case 'tool-update': {
          const hit = this.activities[event.messageId]?.find((a) => a.callId === event.callId)
          if (hit) hit.label = event.label
          break
        }
        case 'tool-end': {
          const hit = this.activities[event.messageId]?.find((a) => a.callId === event.callId)
          if (hit) {
            hit.state = event.ok ? 'ok' : 'error'
            hit.summary = event.summary
          }
          break
        }
        case 'agent-done': {
          const msg = this.messages.find((m) => m.id === event.messageId)
          if (msg) msg.status = 'complete'
          this.speakingAuthor = ''
          break
        }
        case 'chain-done': {
          delete this.chaining[cid]
          this.speakingAuthor = ''
          break
        }
        case 'error': {
          delete this.chaining[cid]
          this.speakingAuthor = ''
          if (event.messageId) {
            const msg = this.messages.find((m) => m.id === event.messageId)
            if (msg && msg.status === 'streaming') msg.status = 'error'
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
