import { generateText } from 'ai'
import { readConfig } from '../config'
import { getModel } from '../db/repo/model'
import { getLanguageModel } from './registry'
import { summarizeForDesign, SUMMARIZE_THRESHOLD } from './summarize'
import type { CompleteFn, SummarizeResult } from './summarize'

/**
 * 辅助模型的接线。
 *
 * 把"配置里选了哪个模型"和"怎么提炼"这两件事接上,并守住一条底线:
 * **提炼失败绝不能让读文档这件事失败**。辅助模型没配、模型被删了、
 * 供应商挂了、密钥过期——任何一种情况都退回原文,顶多少一层压缩。
 * 为了省 token 而让主流程读不到文档,是本末倒置。
 */

export interface SummarizeOutcome {
  /** 最终交给主模型的正文 */
  text: string
  /** 一句话说明发生了什么,拼进工具结果让用户看得见 */
  note: string
  /** 真的压过 */
  summarized: boolean
}

export function hasAssistantModel(): boolean {
  return resolveAssistant() !== null
}

function resolveAssistant(): { providerId: string; modelId: string; label: string } | null {
  const configured = readConfig().assistantModel
  if (!configured) return null

  // 配置里存的是模型行 id;模型可能已经被删掉或停用了
  const row = getModel(configured.modelId)
  if (!row || !row.enabled) return null
  return { providerId: configured.providerId, modelId: row.modelId, label: row.displayName }
}

/**
 * 文档太长就先压一遍。
 *
 * @param hint 用户这轮的诉求,让提炼有的放矢——同一份需求文档,问"做首页"
 *             和问"做设置页"该留下的东西是不一样的
 */
export async function condenseIfLong(text: string, hint?: string): Promise<SummarizeOutcome> {
  if (text.length <= SUMMARIZE_THRESHOLD) {
    return { text, note: '', summarized: false }
  }

  const assistant = resolveAssistant()
  if (!assistant) {
    return {
      text,
      note: `内容较长(${text.length} 字符);设置里还没配辅助模型,给的是原文`,
      summarized: false
    }
  }

  const complete: CompleteFn = async (system, user) => {
    const result = await generateText({
      model: getLanguageModel(assistant.providerId, assistant.modelId),
      system,
      messages: [{ role: 'user', content: user }],
      // 辅助模型挂了不该拖死主流程:上面的 catch 会退回原文继续走。
      // 没有这个超时,一次网络黑洞就是"web_fetch 永远没反应"
      abortSignal: AbortSignal.timeout(90_000)
    })
    return result.text
  }

  try {
    const out: SummarizeResult = await summarizeForDesign(text, complete, hint)
    if (!out.text.trim()) throw new Error('辅助模型没有返回内容')
    return {
      text: out.text,
      note: `原文 ${text.length} 字符,已由「${assistant.label}」提炼成设计要点(${out.chunks} 段)`,
      summarized: true
    }
  } catch (err) {
    // 提炼失败退回原文:少一层压缩总好过读不到文档
    return {
      text,
      note: `内容较长;辅助模型提炼失败(${err instanceof Error ? err.message : String(err)}),给的是原文`,
      summarized: false
    }
  }
}
