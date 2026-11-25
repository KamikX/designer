import { aiText } from '../i18n'
/**
 * 文档提炼:用一个便宜的小模型把长文档压成"设计要用的东西"。
 *
 * ## 为什么是自动触发而不是让主模型自己决定
 *
 * 主模型得先看到文档才知道它有多长——等它发现太长,几万字已经进上下文了,
 * 钱已经花了。所以判断放在工具里:超过阈值先压一遍再交出去。
 *
 * ## 为什么是"面向设计"的提炼而不是通用摘要
 *
 * 通用摘要会写成"本文档介绍了一个运维平台的需求",对做设计稿毫无用处。
 * 我们要的是能直接落到画面上的东西:有哪些页面、每页放什么、字段叫什么、
 * 数值范围多大、有没有品牌约束。所以 prompt 里把这些逐条点名,并且
 * **反复强调保留原文里的具体值**——把"响应时间 < 200ms"压成"性能要求高"
 * 的摘要,等于把这份文档白读了。
 *
 * ## 分层设计
 *
 * 纯逻辑(分块、组装 prompt、合并结果)与"真的调模型"分开:前者可以单测,
 * 后者靠依赖注入,测试时喂一个假的 complete 函数。
 */

/** 超过这么多字符才值得压。短文档直接给原文更准也更省 */
export const SUMMARIZE_THRESHOLD = 8000

/** 每块喂给小模型的字符数。留足余量给 prompt 和输出 */
const CHUNK_CHARS = 18000

/** 最多分几块。再长的文档说明用户该自己挑重点了,不能无限烧钱 */
const MAX_CHUNKS = 6

export const DESIGN_SUMMARY_PROMPT = aiText(
  'ai.summarize.youAreReadingADocumentForAUiDesignerWhoWillBuild'
).trim()

/**
 * 按段落边界分块。
 *
 * 不在句子中间硬切:切断一个表格或一条需求,两边都会变得难以理解。
 * 找不到段落边界时才退回硬切。
 */
export function chunkText(text: string, size = CHUNK_CHARS): string[] {
  const trimmed = text.trim()
  if (trimmed.length <= size) return trimmed ? [trimmed] : []

  const chunks: string[] = []
  let rest = trimmed

  while (rest.length > size && chunks.length < MAX_CHUNKS - 1) {
    const window = rest.slice(0, size)
    // 优先在空行处断,其次换行,都没有才硬切
    let cut = window.lastIndexOf('\n\n')
    if (cut < size * 0.5) cut = window.lastIndexOf('\n')
    if (cut < size * 0.5) cut = size
    chunks.push(rest.slice(0, cut).trim())
    rest = rest.slice(cut).trim()
  }
  if (rest) chunks.push(rest)
  return chunks
}

/** 单块的用户消息 */
export function buildChunkPrompt(
  chunk: string,
  index: number,
  total: number,
  hint?: string
): string {
  const position = total > 1 ? aiText('ai.summarize.thisIsDocumentSectionOf', index + 1, total) : ''
  const purpose = hint?.trim() ? aiText('ai.summarize.theDesignerIsInterestedIn', hint.trim()) : ''
  return aiText('ai.summarize.documentContent', position, purpose, chunk)
}

/** 真正调模型的那一步,由调用方注入,便于单测 */
export type CompleteFn = (system: string, user: string) => Promise<string>

export interface SummarizeResult {
  text: string
  /** 分了几块,用于告诉用户这次花了多少次调用 */
  chunks: number
}

/**
 * 把文档压成设计要用的提炼稿。
 *
 * 多块时逐块提炼再拼接,不做二次归并——归并会把第一块里的具体数字再磨掉
 * 一层,而具体数字正是我们最想留住的东西。分块标题足以让主模型自己串起来。
 */
export async function summarizeForDesign(
  text: string,
  complete: CompleteFn,
  hint?: string
): Promise<SummarizeResult> {
  const chunks = chunkText(text)
  if (chunks.length === 0) return { text: '', chunks: 0 }

  const parts: string[] = []
  for (const [index, chunk] of chunks.entries()) {
    const out = await complete(
      aiText('ai.summarize.youAreReadingADocumentForAUiDesignerWhoWillBuild').trim(),
      buildChunkPrompt(chunk, index, chunks.length, hint)
    )
    parts.push(
      chunks.length > 1 ? aiText('ai.summarize.section', index + 1, out.trim()) : out.trim()
    )
  }
  return { text: parts.join('\n\n'), chunks: chunks.length }
}
