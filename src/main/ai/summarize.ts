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

export const DESIGN_SUMMARY_PROMPT = `
你在为一位 UI 设计师读一份文档。他要照着这份文档做设计稿,所以你的任务
**不是**写内容摘要,而是把"做设计要用到的东西"抽出来。

按下面的结构输出,没有的条目直接省略,不要写"暂无":

## 要做什么
一两句话说清这是个什么产品、给谁用。

## 页面 / 界面
逐条列出文档里提到的页面或视图,每条注明它要展示什么、用户在上面做什么。

## 数据与字段
出现过的字段名、指标名、状态枚举,**用原文的叫法**。数值范围、上限下限
也要带上。

## 流程
用户从哪一步走到哪一步,有分支就写清分支条件。

## 明确的约束
性能指标、合规要求、必须支持的设备或浏览器、品牌与配色要求——凡是文档
里给了确切数字或名称的,**原样保留,不要概括**。

## 存疑
文档里没说清、但做设计必须知道的点。

铁律:宁可多留一个具体数字,也不要为了简洁把它抹掉。"响应时间 < 200ms"
不能写成"性能要求高";"主色 #1677ff"不能写成"蓝色系"。
`.trim()

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
  const position = total > 1 ? `这是文档的第 ${index + 1} / ${total} 部分。\n\n` : ''
  const purpose = hint?.trim() ? `设计师关心的是:${hint.trim()}\n\n` : ''
  return `${position}${purpose}文档内容:\n\n${chunk}`
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
      DESIGN_SUMMARY_PROMPT,
      buildChunkPrompt(chunk, index, chunks.length, hint)
    )
    parts.push(chunks.length > 1 ? `<!-- 第 ${index + 1} 部分 -->\n${out.trim()}` : out.trim())
  }
  return { text: parts.join('\n\n'), chunks: chunks.length }
}
