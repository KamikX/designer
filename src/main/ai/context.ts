import { aiText } from '../i18n'
import type { ModelMessage } from 'ai'
import type { Message } from '../../shared/types'
import { renderAnswer } from './ask-user'

/**
 * 对话上下文组装。
 *
 * 三条策略(一期版):
 * 1. 历史 assistant 消息里的文件正文永不回放——parts 里本来就只有
 *    {type:'file'} 引用,回放时渲染成一行占位说明。最新文件内容由
 *    chat-service 统一注入 system prompt(单点、只一份)。
 * 2. token 预算 = 模型上下文窗口的 60%,字符数/4 粗估。剩下 40% 留给
 *    system prompt、当前文件树注入和模型输出。
 * 3. 超预算从最老的消息开始丢,至少保留最近 4 组对话;丢过就在开头
 *    加一句提示,让模型知道自己看到的不是全部。
 */

const MIN_KEEP = 8

function estimateTokens(text: string): number {
  // 中英混排的经验值:1 token ≈ 4 字符偏乐观、≈2 偏悲观,取 3 折中
  return Math.ceil(text.length / 3)
}

function renderMessage(message: Message): string {
  return message.parts
    .map((part) => {
      if (part.type === 'text') return part.text
      // 问答要回放:用户选过的方向是后续每一轮都该守住的约束,
      // 丢了它模型下一轮就会重新按自己的偏好来
      if (part.type === 'question') {
        return part.answer
          ? renderAnswer(part.ask, part.answer)
          : aiText('ai.context.theUserWasAskedButHasNotAnswered')
      }
      // 图片只在发出它的那一轮带像素。历史里降成引用 + 描述:图片按尺寸
      // 计费,每轮重发一次就是每轮重付一次,而多数后续轮次根本用不着看图
      if (part.type === 'image') {
        const note = part.description ? aiText('ai.context.content', part.description) : ''
        return aiText(
          'ai.context.userReferenceImageUseViewImageWhenYouNeedItsPixels',
          part.assetId,
          part.name,
          note
        )
      }
      if (part.action === 'delete') return aiText('ai.context.deletedFile', part.path)
      return aiText('ai.context.generatedFileItsLatestContentIsInTheCurrentDesignInThe', part.path)
    })
    .filter(Boolean)
    .join('\n')
}

export function buildHistory(history: Message[], contextWindow: number): ModelMessage[] {
  const budget = Math.floor(contextWindow * 0.6)

  const rendered = history
    .filter((m) => m.status === 'complete' || m.status === 'aborted')
    .map((m) => ({
      role: m.role === 'system' ? ('user' as const) : m.role,
      content: renderMessage(m)
    }))
    .filter((m) => m.content.trim().length > 0)

  let total = rendered.reduce((sum, m) => sum + estimateTokens(m.content), 0)
  let dropped = 0
  while (total > budget && rendered.length > MIN_KEEP) {
    const removed = rendered.shift()!
    total -= estimateTokens(removed.content)
    dropped++
  }

  if (dropped > 0) {
    rendered.unshift({
      role: 'user',
      content: aiText(
        'ai.context.systemNoteEarlierMessagesWereOmittedForLengthAskTheUserIf',
        dropped
      )
    })
  }
  return rendered
}
