import type { ModelAbility, ModelType } from './types'

/**
 * 按模型名推断类型与能力。
 *
 * 拉取到的 /models 列表只有 id,没有元数据;这里给一个"大概率正确"
 * 的默认值,用户在配置抽屉里可以逐个纠正。主进程与渲染进程共用
 * 这一份规则,保证两边默认值一致。
 *
 * 两个维度:
 * - type(单值):模型是干什么的——对话 / 绘图 / 向量 / 重排 / 语音。
 * - abilities(多选,仅 chat):识图、文件识别、工具调用。
 */
export function inferModelMeta(modelId: string): { type: ModelType; abilities: ModelAbility[] } {
  const id = modelId.toLowerCase()

  if (/(dall-e|gpt-image|flux|diffusion|cogview|midjourney|imagen|wanx|seedream)/.test(id)) {
    return { type: 'image', abilities: [] }
  }
  if (/(embedding|embed-|bge-|text-embedding|e5-)/.test(id)) {
    return { type: 'embedding', abilities: [] }
  }
  if (/rerank/.test(id)) {
    return { type: 'rerank', abilities: [] }
  }
  if (/(tts|speech-|cosyvoice)/.test(id)) {
    return { type: 'tts', abilities: [] }
  }
  if (/(whisper|asr|paraformer|transcribe|sensevoice)/.test(id)) {
    return { type: 'stt', abilities: [] }
  }

  const abilities: ModelAbility[] = []

  // 识图:已知多模态家族。宁可漏标也不错标——错标会把图塞给
  // 纯文本模型直接报错,漏标只是暂时用不上识图
  if (
    /(gpt-5|gpt-4o|gpt-4\.1|gpt-4-turbo|claude|gemini|glm-4v|glm-4\.5v|glm-4\.6v|qwen-vl|qwen2-vl|qwen3-vl|pixtral|llava|vision)/.test(
      id
    )
  ) {
    abilities.push('vision')
  }

  // 文件识别:API 原生支持文档输入的家族(Claude/Gemini 的 PDF 等)
  if (/(claude|gemini)/.test(id)) {
    abilities.push('files')
  }

  // 工具调用:主流对话模型基本都支持,按家族放行
  if (
    /(gpt-|o[134]|claude|gemini|glm-|deepseek|qwen|kimi|moonshot|mistral|llama|grok|doubao|hunyuan|minimax|step-|yi-)/.test(
      id
    )
  ) {
    abilities.push('tools')
  }

  return { type: 'chat', abilities }
}
