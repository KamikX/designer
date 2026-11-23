import { t } from '@renderer/i18n'
import { MAX_FILES_AT_ONCE } from '@shared/limits'
import type { PreviewMark } from '@renderer/stores/annotation'

/**
 * 附件的两处纯计算。
 *
 * 抽出来是因为这两处**错了都不会报错**:名额算错就静默少附一个文件,
 * 正文拼错就是模型看不见用户刚拖进来的东西——两种都只会表现成"AI 没理我
 * 给的资料",极难往这两行代码上想。
 */

export interface AttachPlan {
  /** 这批里能收下几个 */
  accept: number
  /** 是否超了上限,需要提示改用目录授权 */
  overflow: boolean
}

export function planAttachment(current: number, incoming: number): AttachPlan {
  const room = Math.max(0, MAX_FILES_AT_ONCE - current)
  return { accept: Math.min(room, incoming), overflow: incoming > room }
}

/**
 * 把本轮附的文件写进消息正文。
 *
 * 为什么不只依赖系统提示里的授权清单:聊到第十轮时那份清单里可能有二十个
 * 根,模型分不出**这一句**指的是哪几个。正文里点名才是明确的。
 */
export function composeMessageBody(text: string, paths: string[]): string {
  if (paths.length === 0) return text
  const list = paths.map((p) => `- ${p}`).join('\n')
  return t(
    '{0}\n\n附带文件(用 read_local_file / read_local_document 读取):\n{1}',
    text,
    list
  ).trim()
}

/**
 * 预览标注拼进消息正文。
 *
 * 和附带文件同一个去处:标注是用户**这一句话**的意图,该待在对话里,而不是
 * 塞进每轮重发的 system prompt——那既破前缀缓存,又会在下一轮变成过期噪音。
 *
 * 这一段是自解释的,不需要在提示词里再教模型认格式:有 `文件:行:列` 就按坐标
 * 改,只有签名就 search_files。
 */
export function composeMarks(text: string, marks: PreviewMark[]): string {
  if (marks.length === 0) return text
  const items = marks.map((mark) => renderMark(mark)).join('\n\n')
  const head = t('用户在预览里标记了 {0} 处要改的元素:', marks.length)
  const tail = t(
    '带「源码」的直接按那个位置改;只有签名的用 search_files 按文本或 class 定位后再改。'
  )
  return `${text}\n\n${head}\n\n${items}\n\n${tail}`.trim()
}

function renderMark(mark: PreviewMark): string {
  const { target } = mark
  const lines = [`[${mark.index}] ${target.tag}${target.id ? `#${target.id}` : ''}`]
  if (target.source) lines.push(t('  源码:{0}', target.source))
  if (target.text) lines.push(t('  文本:{0}', clean(target.text)))
  if (target.classes.length) lines.push(`  class:${clean(target.classes.join(' '))}`)
  const attrs = Object.entries(target.attrs)
  if (attrs.length)
    lines.push(t('  属性:{0}', clean(attrs.map(([k, v]) => `${k}="${v}"`).join(' '))))
  if (target.path) lines.push(t('  路径:{0}', clean(target.path)))
  // 有源码坐标时原文就是冗余;没有时它是模型最后的定位线索
  if (!target.source && target.html) lines.push(t('  原文:{0}', clean(target.html)))
  lines.push(t('  备注:{0}', clean(mark.note) || '(没写备注,按上下文判断)'))
  return lines.join('\n')
}

/**
 * 元素原文与备注都是不可信输入(备注是用户敲的,原文来自 AI 生成的页面),
 * 直接拼进正文可能带 ``` 把后面的内容顶成代码块,或者换行破坏这段的结构。
 */
function clean(value: string): string {
  return value
    .replace(/`{3,}/g, (fence) => '\\`'.repeat(fence.length))
    .replace(/\s+/g, ' ')
    .trim()
}
