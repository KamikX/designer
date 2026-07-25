import { randomUUID } from 'crypto'
import { streamText } from 'ai'
import type { WebContents } from 'electron'
import type {
  ChatStreamEvent,
  MessagePart,
  SendChatInput,
  SendChatResult
} from '../../shared/types'
import { getModel } from '../db/repo/model'
import { getProviderRowById } from '../db/repo/provider'
import { createMessage, listMessages, updateMessage } from '../db/repo/message'
import { getConversation } from '../db/repo/conversation'
import { getProject, touchProject } from '../db/repo/project'
import { createArtifactVersion, getArtifactFiles, latestArtifact } from '../db/repo/artifact'
import { buildHistory } from './context'
import { buildSystemPrompt } from './prompts'
import { FileStreamParser } from './file-stream-parser'
import { errorMessage, getLanguageModel } from './registry'

/**
 * 流式对话编排。
 *
 * 协议:invoke 发起立即返回 streamId(两条消息已落库,assistant 置
 * streaming),之后所有增量走 `chat:stream` 单通道 send,渲染层按
 * streamId 路由。发送目标用发起请求的 WebContents——天然对准正确窗口。
 *
 * 模型输出经 FileStreamParser 分流:解说文本走 delta,<antdFile> 走
 * file-* 事件;流结束后若产生文件变更,基于最新版本合并出新 artifact。
 */

const running = new Map<string, AbortController>()

export function sendChat(sender: WebContents, input: SendChatInput): SendChatResult {
  const conversation = getConversation(input.conversationId)
  if (!conversation) throw new Error('会话不存在')
  const project = getProject(conversation.projectId)
  if (!project) throw new Error('项目不存在')

  const provider = getProviderRowById(input.providerId)
  if (!provider) throw new Error('供应商不存在')
  const model = getModel(input.modelId)
  if (!model) throw new Error('模型不存在')

  // 历史与当前设计稿在落库新消息之前取
  const history = buildHistory(listMessages(input.conversationId), model.contextWindow)
  const base = latestArtifact(project.id)
  const currentFiles = base ? getArtifactFiles(base.id) : []

  const userMessage = createMessage({
    conversationId: input.conversationId,
    role: 'user',
    parts: [{ type: 'text', text: input.text }]
  })
  const assistantMessage = createMessage({
    conversationId: input.conversationId,
    role: 'assistant',
    parts: [],
    status: 'streaming',
    providerSlug: provider.slug,
    modelId: model.modelId
  })
  touchProject(project.id)

  const streamId = randomUUID()
  const abort = new AbortController()
  running.set(streamId, abort)

  const emit = (event: ChatStreamEvent): void => {
    if (!sender.isDestroyed()) sender.send('chat:stream', event)
  }

  const parser = new FileStreamParser()

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
      const result = streamText({
        model: getLanguageModel(input.providerId, model!.modelId),
        system: buildSystemPrompt(project!, currentFiles),
        messages: [...history, { role: 'user', content: input.text }],
        abortSignal: abort.signal
      })

      for await (const delta of result.textStream) {
        relay(parser.push(delta))
      }
      relay(parser.finish())

      const usage = await result.usage
      finalize('complete', {
        inputTokens: usage.inputTokens ?? 0,
        outputTokens: usage.outputTokens ?? 0
      })
    } catch (err) {
      relay(parser.finish())
      if (abort.signal.aborted) {
        // 中止不算错误:已解析完成的文件照常成版本(部分产物可用)
        finalize('aborted', null)
      } else {
        finalize('error', null)
        emit({ streamId, type: 'error', message: errorMessage(err) })
      }
    } finally {
      running.delete(streamId)
    }
  }

  function finalize(
    status: 'complete' | 'aborted' | 'error',
    usage: { inputTokens: number; outputTokens: number } | null
  ): void {
    // 出错时不落半成品版本;中止/完成时落
    let artifactId: string | null = null
    if (status !== 'error' && parser.hasChanges) {
      const artifact = createArtifactVersion({
        projectId: project!.id,
        messageId: assistantMessage.id,
        baseArtifactId: base?.id ?? null,
        writes: parser.files,
        deletes: parser.deleted,
        summary: parser.narration.trim().slice(0, 200)
      })
      artifactId = artifact.id
    }

    const parts: MessagePart[] = []
    const narration = parser.narration.trim()
    if (narration) parts.push({ type: 'text', text: narration })
    for (const path of parser.files.keys()) parts.push({ type: 'file', path, action: 'write' })
    for (const path of parser.deleted) parts.push({ type: 'file', path, action: 'delete' })

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
  }

  return { streamId, userMessageId: userMessage.id, assistantMessageId: assistantMessage.id }
}

export function abortChat(streamId: string): void {
  running.get(streamId)?.abort()
}
