import { defineStore } from 'pinia'
import type { ChatStreamEvent, ChatUsage, Message } from '@shared/types'
import { useArtifactStore } from './artifact'

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

export const useChatStore = defineStore('chat', {
  state: () => ({
    conversationId: '' as string,
    messages: [] as Message[],
    /** 当前进行中的流(一期同一时刻只允许一个) */
    stream: null as StreamState | null,
    error: '' as string,
    /** 工作台模型选择(内存态,会话期间记住) */
    selected: null as { providerId: string; modelId: string } | null,
    /**
     * 本会话启用的 MCP 服务 / 技能(内存态)。null 表示"跟随全局启用状态";
     * 用户在输入框工具条里勾选后变为显式集合。运行时接入后随请求下发。
     */
    mcpIds: null as string[] | null,
    skillIds: null as string[] | null,
    unsubscribe: null as (() => void) | null
  }),

  getters: {
    streaming(state): boolean {
      return state.stream != null
    }
  },

  actions: {
    /** 进入工作台时调用。重复调用只在会话变化时重新拉取 */
    async openConversation(conversationId: string): Promise<void> {
      this.ensureSubscribed()
      if (this.conversationId === conversationId) return
      this.conversationId = conversationId
      this.messages = await window.api.chat.listMessages(conversationId)
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
        case 'file-delete': {
          message.parts.push({ type: 'file', path: event.path, action: 'delete' })
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
          break
        }
        case 'error': {
          message.status = 'error'
          this.error = event.message
          this.stream = null
          break
        }
      }
    },

    async send(text: string): Promise<void> {
      if (!this.selected || this.streaming || !text.trim()) return
      this.error = ''
      const result = await window.api.chat.send({
        conversationId: this.conversationId,
        text: text.trim(),
        providerId: this.selected.providerId,
        modelId: this.selected.modelId
      })
      // 主进程已落库,这里按返回的 id 就地补上本地态,不用重新拉全量
      this.messages.push({
        id: result.userMessageId,
        conversationId: this.conversationId,
        role: 'user',
        parts: [{ type: 'text', text: text.trim() }],
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
    }
  }
})
