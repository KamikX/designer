import { text as appText } from '../i18n'
/**
 * 文本嗅探:这个文件到底能不能当文本读。
 *
 * ## 为什么不能只看后缀
 *
 * 之前只查一张扩展名黑名单,后果是:后缀不在表里的二进制(`.dat`、无后缀、
 * `.pyc`、sqlite 库…)会一路走到 `readFileSync(path, 'utf-8')`。而 Node
 * **不会为此抛错**——它把非法字节替换成 U+FFFD,安安静静返回一坨乱码。
 * 模型拿到一屏垃圾,完全不知道那不是文件内容,然后照着乱码做判断。
 *
 * 所以判定必须落到**内容**上:先看 BOM,再看有没有 NUL 字节,最后严格试解
 * UTF-8。判不了就明确告诉调用方"读不了,原因是什么",而不是给一坨脏数据。
 *
 * ## 为什么顺带支持 UTF-16
 *
 * 带 BOM 的 UTF-16 是**无歧义**的:认出来就能正确解码,不认就是一串乱码。
 * Windows 上的导出文件、PowerShell 重定向的结果常是这个编码。识别成本
 * 只有几行,收益是这类文件从"读不了"变成"读得对"。
 */

import { identify } from './magic'
import type { FormatInfo } from './magic'

/** 嗅探时看多少字节就够了。前 8KB 足以暴露二进制特征,也不用把大文件整个读进来 */
export const SNIFF_BYTES = 8192

export type TextEncoding = 'utf8' | 'utf16le' | 'utf16be'

export type SniffResult =
  | { ok: true; encoding: TextEncoding; bomBytes: number }
  /** reason 是给模型看的人话,会原样出现在工具结果里 */
  | { ok: false; reason: string; format?: FormatInfo }

/**
 * 判不了的时候,补一句"这到底是什么"。
 *
 * 魔数不参与"能不能读"的判定——那是 UTF-8 解码的事,而且 GBK 文本这类
 * 根本没有魔数。它只负责把"含有 NUL 字节"这种技术性描述,换成"这是 PNG
 * 图片"这种模型和用户都能直接用的信息。
 */
function reject(sample: Buffer, reason: string): SniffResult {
  const format = identify(sample)
  if (!format) return { ok: false, reason }
  return {
    ok: false,
    reason: appText('messages.thisIsAndCannotBeReadAsText', format.label),
    format
  }
}

/** 控制字符占比超过这个值就判为二进制(制表/换行/回车不算) */
const CONTROL_RATIO_LIMIT = 0.02

export function sniff(sample: Buffer): SniffResult {
  if (sample.length === 0) return { ok: true, encoding: 'utf8', bomBytes: 0 }

  // BOM 优先:它是明确的自我声明,比任何统计判据都可靠
  if (sample.length >= 4) {
    const utf32 =
      (sample[0] === 0xff && sample[1] === 0xfe && sample[2] === 0x00 && sample[3] === 0x00) ||
      (sample[0] === 0x00 && sample[1] === 0x00 && sample[2] === 0xfe && sample[3] === 0xff)
    if (utf32)
      return { ok: false, reason: appText('messages.utf32IsNotSupportedConvertToUtf8First') }
  }
  if (sample.length >= 3 && sample[0] === 0xef && sample[1] === 0xbb && sample[2] === 0xbf) {
    return { ok: true, encoding: 'utf8', bomBytes: 3 }
  }
  if (sample.length >= 2) {
    if (sample[0] === 0xff && sample[1] === 0xfe)
      return { ok: true, encoding: 'utf16le', bomBytes: 2 }
    if (sample[0] === 0xfe && sample[1] === 0xff)
      return { ok: true, encoding: 'utf16be', bomBytes: 2 }
  }

  // NUL 字节是二进制最硬的信号(git 用的也是这一条)
  if (sample.includes(0x00)) {
    return reject(
      sample,
      appText('workspace.text.containsNulBytesThisIsBinaryContentAndCannotBeReadAs')
    )
  }

  // 严格试解 UTF-8。stream: true 让结尾被截断的多字节序列不算错——
  // 我们只嗅探前 8KB,最后一个字符大概率是被切开的
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(sample, { stream: true })
  } catch {
    return reject(
      sample,
      appText('workspace.text.notValidUtf8PossiblyGbkAnotherEncodingOrBinaryConvertTo')
    )
  }

  if (controlRatio(sample) > CONTROL_RATIO_LIMIT) {
    return reject(
      sample,
      appText('workspace.text.tooManyControlCharactersThisDoesNotAppearToBeAText')
    )
  }

  return { ok: true, encoding: 'utf8', bomBytes: 0 }
}

/** 制表、换行、回车、换页之外的控制字符占比 */
function controlRatio(sample: Buffer): number {
  let control = 0
  for (const byte of sample) {
    if (byte === 0x09 || byte === 0x0a || byte === 0x0d || byte === 0x0c) continue
    if (byte < 0x20 || byte === 0x7f) control++
  }
  return control / sample.length
}

/** 按嗅探结果解码整份内容。BOM 会被去掉,不该出现在正文里 */
export function decode(buffer: Buffer, encoding: TextEncoding, bomBytes: number): string {
  const body = bomBytes > 0 ? buffer.subarray(bomBytes) : buffer

  if (encoding === 'utf16le') return body.toString('utf16le')
  if (encoding === 'utf16be') {
    // Node 没有 utf16be:复制一份再字节交换,别动调用方的 buffer
    const swapped = Buffer.from(body)
    // 奇数长度时最后一个字节配不成对,丢掉——本来也是坏数据
    const even = swapped.length - (swapped.length % 2)
    return swapped.subarray(0, even).swap16().toString('utf16le')
  }
  return body.toString('utf-8')
}
