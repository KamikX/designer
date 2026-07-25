import { randomUUID } from 'crypto'
import { tool } from 'ai'
import type { ToolSet } from 'ai'
import { z } from 'zod'
import type { AskUserAnswer, AskUserInput } from '../../shared/types'

/**
 * 交互式提问工具。
 *
 * AI 在动手之前先跟用户确认方向(风格、配色、信息密度…),而不是猜一版
 * 再让用户推翻重来——推翻一版的代价是整份设计稿重出。
 *
 * ## 为什么敢让工具阻塞
 *
 * `execute` 返回一个"等用户作答"的 Promise,整个 streamText 循环就停在
 * 这一步。看上去很危险,其实不是:工具循环走到这里时,**模型那一步已经
 * 返回了**,我们停在两步之间——此刻没有任何打开的 HTTP 连接,供应商侧
 * 不存在超时一说。下一次请求要等工具 resolve 之后才发出。
 *
 * 真正要接住的是另外三件事,都在下面处理了:
 * - 用户点了停止 → abortSignal 触发 → 按"跳过"收尾
 * - 用户关窗走人 → ANSWER_TIMEOUT 兜底,不让回合永远挂着
 * - 用户点了跳过 → 明确告诉模型别再追问,按自己的判断继续
 *
 * ## 与文件工具无关
 *
 * 这个工具不碰 VFS,后面做通用 chat 时可以原样复用。
 */

/** 等作答的超时兜底:用户可能关窗走人,回合不能永远挂着 */
const ANSWER_TIMEOUT_MS = 30 * 60 * 1000

/** 一次最多问几题:再多用户就不填了 */
const MAX_QUESTIONS = 4

interface Pending {
  streamId: string
  resolve: (answer: AskUserAnswer) => void
}

const pending = new Map<string, Pending>()

/** 渲染层提交答案。返回 false 表示这道题已经不在等了(超时 / 中止 / 重复提交) */
export function answerQuestion(questionId: string, answer: AskUserAnswer): boolean {
  const entry = pending.get(questionId)
  if (!entry) return false
  pending.delete(questionId)
  entry.resolve(answer)
  return true
}

/** 回合结束 / 中止时,把这条流上还挂着的提问一律按跳过收掉 */
export function releaseQuestions(streamId: string): void {
  for (const [id, entry] of [...pending]) {
    if (entry.streamId !== streamId) continue
    pending.delete(id)
    entry.resolve({ selections: [], skipped: true })
  }
}

export interface AskUserContext {
  streamId: string
  /** 把问题推给渲染层 */
  emit: (questionId: string, ask: AskUserInput) => void
  /** 作答后回调,供 chat-service 把问答存进消息 parts */
  onAnswered: (questionId: string, ask: AskUserInput, answer: AskUserAnswer) => void
  signal: AbortSignal
}

export function buildAskUserTool(context: AskUserContext): ToolSet {
  const tools = {
    ask_user: tool({
      description:
        '在动手之前向用户确认方向。方向不明确时**先问再做**——猜错一版的代价是整份设计稿重出,' +
        '而问一次只要用户点几下。\n' +
        '适合问:风格倾向、配色、信息密度、目标人群、要不要某个模块。\n' +
        '不要问:实现细节、你自己能定的小事、用户已经在需求里说清楚的东西。\n' +
        `一次最多 ${MAX_QUESTIONS} 题,每题给 2-4 个**具体**的选项(不要"简约风/复杂风"这种废话选项),` +
        '选项配一句释义帮用户判断。用户可能跳过,跳过就按你的判断继续,不要再问第二次。',
      inputSchema: z.object({
        intro: z.string().optional().describe('一句话说明为什么要问,让用户知道这几题影响什么'),
        questions: z
          .array(
            z.object({
              header: z.string().describe('极短标签,不超过 8 个字,如「风格」「配色」'),
              question: z.string().describe('完整问题'),
              kind: z.enum(['single', 'multiple']).describe('single 单选 / multiple 多选'),
              options: z
                .array(
                  z.object({
                    label: z.string().describe('选项名,简短'),
                    description: z.string().optional().describe('一句话释义,帮用户判断')
                  })
                )
                .min(2)
                .max(4),
              allowCustom: z.boolean().optional().describe('允许用户自己填一个选项之外的答案')
            })
          )
          .min(1)
          .max(MAX_QUESTIONS),
        notes: z
          .object({
            label: z.string(),
            placeholder: z.string().optional()
          })
          .optional()
          .describe('末尾附一个自由描述框,让用户补充选项覆盖不到的信息')
      }),
      execute: async (input) => {
        const ask = input as AskUserInput
        const questionId = randomUUID()
        const answer = await waitForAnswer(context, questionId, ask)
        context.onAnswered(questionId, ask, answer)
        return renderAnswer(ask, answer)
      }
    })
  }
  return tools
}

function waitForAnswer(
  context: AskUserContext,
  questionId: string,
  ask: AskUserInput
): Promise<AskUserAnswer> {
  return new Promise<AskUserAnswer>((resolve) => {
    let settled = false
    const finish = (answer: AskUserAnswer): void => {
      if (settled) return
      settled = true
      pending.delete(questionId)
      clearTimeout(timer)
      context.signal.removeEventListener('abort', onAbort)
      resolve(answer)
    }

    const onAbort = (): void => finish({ selections: [], skipped: true })
    const timer = setTimeout(() => finish({ selections: [], skipped: true }), ANSWER_TIMEOUT_MS)

    // 已经中止了就别问了,直接按跳过走
    if (context.signal.aborted) {
      finish({ selections: [], skipped: true })
      return
    }
    context.signal.addEventListener('abort', onAbort, { once: true })

    pending.set(questionId, { streamId: context.streamId, resolve: finish })
    context.emit(questionId, ask)
  })
}

/**
 * 答案转成给模型看的文本。
 *
 * 不直接回 JSON:模型读散文比读结构体稳,而且这段会随后续每一步重发,
 * 散文也更短。
 */
export function renderAnswer(ask: AskUserInput, answer: AskUserAnswer): string {
  if (answer.skipped) {
    return '用户跳过了这次确认。请按你自己的判断继续,不要再问一次。'
  }

  const lines = ask.questions.map((question, index) => {
    const picked = answer.selections[index] ?? []
    return `- ${question.header}:${picked.length ? picked.join('、') : '(未选)'}`
  })

  const notes = answer.notes?.trim()
  if (notes) lines.push(`- 补充说明:${notes}`)

  return `用户的选择:\n${lines.join('\n')}`
}
