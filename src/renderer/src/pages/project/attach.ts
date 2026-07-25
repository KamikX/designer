import { MAX_FILES_AT_ONCE } from '@shared/limits'

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
  return `${text}\n\n附带文件(用 read_local_file / read_local_document 读取):\n${list}`.trim()
}
