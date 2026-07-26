import { createHash, randomUUID } from 'node:crypto'

/**
 * 锚点注册表:把"文件里的一段原文"绑定到捕获那一刻的修订号。
 *
 * ## 为什么要有它
 *
 * 编辑失败的大头是模型**复述**旧文本时抄错一个字符——尤其是被截断的超长
 * 行。锚点让服务端持有精确区间,模型只引用 anchorId,不再复述原文,
 * `MATCH_NOT_FOUND` 这一类失败从根上消失。
 *
 * ## 坐标契约
 *
 * 输入与读取工具对齐:1 起、行列两端都包含、列按 JavaScript UTF-16
 * code unit 计数。内部统一转换为半开区间 [startOffset, endOffset)。
 * 所有锚点非空;revision 用**相等**校验(不是大小),内容 hash 兜底。
 */

export type AnchorErrorCode = 'ANCHOR_NOT_FOUND' | 'ANCHOR_STALE' | 'INVALID_RANGE'

export class AnchorError extends Error {
  constructor(
    public readonly code: AnchorErrorCode,
    message: string
  ) {
    super(message)
    this.name = 'AnchorError'
  }
}

export interface AnchorRecord {
  id: string
  path: string
  revision: number
  /** UTF-16 code unit 偏移,半开区间 */
  startOffset: number
  endOffset: number
  contentHash: string
}

export interface RangeInput {
  /** 1 起,包含 */
  startLine: number
  /** 缺省等于起始行 */
  endLine?: number
  /** 1 起,UTF-16 code unit,包含;缺省取行首 */
  startColumn?: number
  /** 1 起,包含;缺省取结束行行尾 */
  endColumn?: number
  /** 显式包含结束行后的换行(整行删除用);最后一行没有换行则报错 */
  includeTrailingNewline?: boolean
}

interface LineSpan {
  /** 行首偏移 */
  start: number
  /** 行内容结束偏移(不含 \r\n / \n) */
  end: number
  /** 行终结符长度:\n=1、\r\n=2、文件末尾=0 */
  terminator: number
}

/** 按物理行切分并记录偏移。行内容不含 \r——CRLF 当作一个整体终结符 */
function lineSpans(content: string): LineSpan[] {
  const spans: LineSpan[] = []
  let start = 0
  for (;;) {
    const nl = content.indexOf('\n', start)
    if (nl < 0) {
      spans.push({ start, end: content.length, terminator: 0 })
      return spans
    }
    const crlf = nl > start && content[nl - 1] === '\r'
    spans.push({ start, end: crlf ? nl - 1 : nl, terminator: crlf ? 2 : 1 })
    start = nl + 1
  }
}

function isLowSurrogate(code: number | undefined): boolean {
  return code !== undefined && code >= 0xdc00 && code <= 0xdfff
}

function hashOf(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16)
}

export class AnchorRegistry {
  private anchors = new Map<string, AnchorRecord>()

  /** 把 1 起行列坐标转成半开偏移区间,校验后登记锚点并返回精确原文 */
  capture(
    path: string,
    revision: number,
    content: string,
    range: RangeInput
  ): { anchor: AnchorRecord; text: string } {
    const spans = lineSpans(content)
    const total = spans.length

    const startLine = range.startLine
    const endLine = range.endLine ?? startLine
    if (!Number.isInteger(startLine) || startLine < 1 || startLine > total) {
      throw new AnchorError('INVALID_RANGE', `起始行 ${startLine} 超出文件范围(共 ${total} 行)。`)
    }
    if (!Number.isInteger(endLine) || endLine < startLine || endLine > total) {
      throw new AnchorError(
        'INVALID_RANGE',
        `结束行 ${endLine} 无效(须在 ${startLine}-${total} 之间)。`
      )
    }

    const startSpan = spans[startLine - 1]
    const endSpan = spans[endLine - 1]
    const startLen = startSpan.end - startSpan.start
    const endLen = endSpan.end - endSpan.start

    const startColumn = range.startColumn ?? 1
    if (startColumn < 1 || (startLen > 0 && startColumn > startLen)) {
      throw new AnchorError(
        'INVALID_RANGE',
        `起始列 ${startColumn} 超出第 ${startLine} 行(该行 ${startLen} 个字符)。`
      )
    }
    const endColumn = range.endColumn ?? endLen
    if (range.endColumn !== undefined && (endColumn < 1 || endColumn > endLen)) {
      throw new AnchorError(
        'INVALID_RANGE',
        `结束列 ${endColumn} 超出第 ${endLine} 行(该行 ${endLen} 个字符)。`
      )
    }

    const startOffset = startSpan.start + (startColumn - 1)
    let endOffset = endSpan.start + endColumn

    if (range.includeTrailingNewline) {
      if (range.endColumn !== undefined && range.endColumn !== endLen) {
        throw new AnchorError('INVALID_RANGE', '只有整行区间才能包含结尾换行。')
      }
      if (endSpan.terminator === 0) {
        throw new AnchorError('INVALID_RANGE', `第 ${endLine} 行是文件最后一行,没有结尾换行。`)
      }
      endOffset = endSpan.end + endSpan.terminator
    }

    return {
      anchor: this.registerOffsets(path, revision, content, startOffset, endOffset),
      text: content.slice(startOffset, endOffset)
    }
  }

  /** 直接按偏移登记(search matchId 用)。同样做非空 / 边界 / 代理对校验 */
  registerOffsets(
    path: string,
    revision: number,
    content: string,
    startOffset: number,
    endOffset: number
  ): AnchorRecord {
    if (
      !Number.isInteger(startOffset) ||
      !Number.isInteger(endOffset) ||
      startOffset < 0 ||
      endOffset > content.length
    ) {
      throw new AnchorError('INVALID_RANGE', '区间越界。')
    }
    if (startOffset >= endOffset) {
      throw new AnchorError('INVALID_RANGE', '锚点区间不能为空。')
    }
    // 切在 surrogate pair 中间的区间,取出来是坏字符,写回去更是灾难
    if (isLowSurrogate(content.charCodeAt(startOffset))) {
      throw new AnchorError('INVALID_RANGE', '起点落在代理对(emoji 等)中间。')
    }
    if (isLowSurrogate(content.charCodeAt(endOffset))) {
      throw new AnchorError('INVALID_RANGE', '终点落在代理对(emoji 等)中间。')
    }

    const anchor: AnchorRecord = {
      id: randomUUID(),
      path,
      revision,
      startOffset,
      endOffset,
      contentHash: hashOf(content.slice(startOffset, endOffset))
    }
    this.anchors.set(anchor.id, anchor)
    return anchor
  }

  get(id: string): AnchorRecord | undefined {
    return this.anchors.get(id)
  }

  /**
   * 取出并校验锚点:修订号必须相等,原文 hash 必须一致。
   * 两道都过不了的锚点宁可报 STALE 让模型重新定位,也不能让它写歪。
   */
  resolve(id: string, currentRevision: number, content: string): AnchorRecord {
    const anchor = this.anchors.get(id)
    if (!anchor) {
      throw new AnchorError('ANCHOR_NOT_FOUND', `锚点 ${id} 不存在,请重新 capture_range 或搜索。`)
    }
    if (anchor.revision !== currentRevision) {
      throw new AnchorError(
        'ANCHOR_STALE',
        `锚点 ${id} 基于修订 ${anchor.revision},文件已是修订 ${currentRevision},请重新定位。`
      )
    }
    const slice = content.slice(anchor.startOffset, anchor.endOffset)
    if (hashOf(slice) !== anchor.contentHash) {
      throw new AnchorError('ANCHOR_STALE', `锚点 ${id} 的原文已变化,请重新定位。`)
    }
    return anchor
  }

  /** 文件提交了新修订:该文件所有旧修订的锚点立即失效 */
  invalidatePath(path: string, newRevision: number): void {
    for (const [id, anchor] of this.anchors) {
      if (anchor.path === path && anchor.revision !== newRevision) this.anchors.delete(id)
    }
  }

  clear(): void {
    this.anchors.clear()
  }
}
