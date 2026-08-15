import { readConfig } from '../config'

/**
 * OpenAI 协议的兼容参数,**所有**模型入口(设计/纯聊天、群组、辅助模型、
 * 供应商连通性测试)都必须带上,不能只写在某一条链路里。
 *
 * 教训:这段最早只在 chat-service 里,群组一上多步工具调用就复发了
 * "Item with id 'rs_...' not found"——SDK 在第二步把上一步的 reasoning
 * 条目按服务端 id 回传,而不持久化的中转站根本没存过它。开关取舍见
 * AppConfig 注释;默认值按"面对一个能力未知的中转站"来选(store=false
 * 且不带非标准 include),不是按直连 OpenAI 选的。
 */
export function openaiCompatOptions(): Record<string, string[] | boolean> {
  const { store, encryptedReasoning } = readConfig().openaiCompat
  return {
    store,
    // include 只在开关打开时才出现在请求体里。传一个空数组也是"发了这个
    // 字段",而不认识它的后端照样可能翻车
    ...(encryptedReasoning ? { include: ['reasoning.encrypted_content'] } : {})
  }
}

/**
 * 推理档位 → 各家 thinking 预算(tokens)。数值取"能明显改善设计决策、
 * 又不至于把单步拖到分钟级"的区间,和各家文档的推荐范围一致。
 */
const THINKING_BUDGET = { low: 2048, medium: 8192, high: 16384 } as const

type Json = string | number | boolean | null | Json[] | { [key: string]: Json }

export interface ReasoningRequestOptions {
  providerOptions: Record<string, Record<string, Json>>
  /** anthropic 开 thinking 时 max_tokens 必须大于预算,这里连带给出输出上限 */
  maxOutputTokens?: number
}

/**
 * 按供应商 adapter 映射推理档位。off(默认)返回空——一个字段都不多发,
 * 行为与没有这个功能时完全一致。
 *
 * 不覆盖 deepseek 和 openai-compatible:deepseek-chat 不认这些参数
 * (deepseek-reasoner 则总是推理),中转站对非标字段常回 500 而不是 400,
 * 宁可不发。
 */
export function reasoningRequestOptions(
  adapter: string | null | undefined
): ReasoningRequestOptions {
  const effort = readConfig().reasoningEffort ?? 'off'
  if (effort === 'off') return { providerOptions: {} }

  if (adapter === 'anthropic') {
    const budgetTokens = THINKING_BUDGET[effort]
    return {
      providerOptions: { anthropic: { thinking: { type: 'enabled', budgetTokens } } },
      // thinking 计入 max_tokens,预算之外还要给正文留足空间
      maxOutputTokens: budgetTokens + 16384
    }
  }
  if (adapter === 'openai') {
    return { providerOptions: { openai: { reasoningEffort: effort } } }
  }
  if (adapter === 'google') {
    return {
      providerOptions: { google: { thinkingConfig: { thinkingBudget: THINKING_BUDGET[effort] } } }
    }
  }
  return { providerOptions: {} }
}
