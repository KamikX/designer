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
