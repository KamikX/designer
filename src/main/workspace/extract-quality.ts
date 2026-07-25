/**
 * 判断从文档里抽出来的文字到底能不能用。
 *
 * ## 为什么必须判
 *
 * PDF 抽文字有三种结局,而**它们都不会报错**:
 *
 * 1. 正常:抽出可读文本
 * 2. 扫描件:整份是图片,抽出来几乎是空的
 * 3. 字体映射坏了:抽出一堆 `(cid:123)` 或乱码字符
 *
 * 后两种如果直接交给模型,它会拿着空白或乱码一本正经地往下推理。所以要在
 * 交出去之前自己判一次:判定为不可用时,改走"把页面渲染成图片给多模态模型"
 * 这条路——那条路对扫描件反而是唯一正确的路。
 *
 * ## 判据都要能解释
 *
 * 每条判据都得能对用户说清楚为什么("每页只有 3 个字符,像是扫描件"),
 * 因为最终这句话会出现在对话里。不做黑箱打分。
 */

export type ExtractionVerdict =
  | { usable: true }
  | {
      usable: false
      /** scanned:没文字,多半是扫描件;garbled:有文字但是乱的 */
      kind: 'scanned' | 'garbled'
      /** 给模型和用户看的人话 */
      reason: string
    }

/** 每页少于这么多字符就认为"基本没抽到东西" */
const MIN_CHARS_PER_PAGE = 24
/** cid 占位符出现这么多次就认定字体映射坏了 */
const CID_LIMIT = 5
/** 替换字符(U+FFFD)占比上限 */
const REPLACEMENT_RATIO = 0.02
/** 可读字符(中日韩 / 字母 / 数字)占比下限 */
const READABLE_RATIO = 0.35

/** pdfjs 抽不出字形映射时会吐 `(cid:123)` 这种占位 */
const CID_PATTERN = /\(cid:\d+\)/g

export function assessExtraction(text: string, pageCount = 1): ExtractionVerdict {
  const trimmed = text.trim()
  const pages = Math.max(1, pageCount)

  if (trimmed.length < MIN_CHARS_PER_PAGE * pages) {
    return {
      usable: false,
      kind: 'scanned',
      reason:
        trimmed.length === 0
          ? '没有抽到任何文字,整份文档多半是扫描件或纯图片。'
          : `${pages} 页只抽到 ${trimmed.length} 个字符,多半是扫描件或纯图片。`
    }
  }

  const cids = trimmed.match(CID_PATTERN)?.length ?? 0
  if (cids >= CID_LIMIT) {
    return {
      usable: false,
      kind: 'garbled',
      reason: `抽出的内容里有 ${cids} 处 (cid:N) 占位符,说明字体映射缺失,文字取不出来。`
    }
  }

  const replacement = count(trimmed, '�')
  if (replacement / trimmed.length > REPLACEMENT_RATIO) {
    return {
      usable: false,
      kind: 'garbled',
      reason: '抽出的内容里大量字符无法解码,是乱码。'
    }
  }

  if (readableRatio(trimmed) < READABLE_RATIO) {
    return {
      usable: false,
      kind: 'garbled',
      reason: '抽出的内容里几乎没有可识别的文字,是乱码。'
    }
  }

  return { usable: true }
}

function count(text: string, char: string): number {
  let n = 0
  for (const c of text) if (c === char) n++
  return n
}

/**
 * 中日韩 / 拉丁字母 / 数字 占全部**非空白**字符的比例。
 *
 * 正常文档哪怕全是标点和符号也不会低到 35%;乱码则通常是一堆生僻符号,
 * 比例会掉得很明显。
 */
function readableRatio(text: string): number {
  let readable = 0
  let total = 0
  for (const char of text) {
    if (/\s/.test(char)) continue
    total++
    if (
      /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}a-zA-Z0-9]/u.test(char)
    ) {
      readable++
    }
  }
  return total === 0 ? 0 : readable / total
}
