import type { ToolActivity } from '@renderer/stores/chat'

/**
 * 把一条消息的正文与工具调用**按发生顺序**切成段。
 *
 * ## 为什么不能都堆在气泡底部
 *
 * 工具活动原来是气泡末尾的一整块,于是一条消息读起来是"一大段解说 + 一坨
 * 十七行工具":哪句话之前调了什么、结果影响了后面哪一段,全看不出来。而模型
 * 的实际节奏是**说一句 → 调一次 → 再说一句**,把这个顺序还原出来,消息才是
 * 一条能顺着读下去的链。
 *
 * ## 顺序是怎么恢复的
 *
 * 工具活动不落库(它是过程信息),所以不能靠 parts 排序。改为在 tool-start
 * 那一刻记下**当时正文已经有多少字**(`afterChars`),渲染时按这些位置切开
 * 正文即可。代价是一个数字,换来的是不动 MessagePart、不动数据库。
 *
 * 没有 `afterChars` 的活动(从库里重新加载的老消息)一律当作发生在末尾——
 * 也就是退回今天的行为,不会因为缺字段而把顺序编错。
 */

export type MessageSegment =
  | { kind: 'text'; text: string }
  /** 同一批(同一个 afterChars)的并行调用合成一组,交给 ToolActivityList 折叠 */
  | { kind: 'tools'; activities: ToolActivity[] }

export function splitMessageStream(
  text: string,
  activities: readonly ToolActivity[]
): MessageSegment[] {
  if (activities.length === 0) return text ? [{ kind: 'text', text }] : []

  const segments: MessageSegment[] = []
  let cursor = 0

  for (const activity of activities) {
    // 缺字段的按末尾算;位置不允许回退,否则正文会被切乱
    const raw = activity.afterChars ?? text.length
    const at = Math.min(Math.max(raw, cursor), text.length)

    const previous = segments[segments.length - 1]
    if (at === cursor && previous?.kind === 'tools') {
      // 紧挨着、位置相同 = 同一步里并行发出的调用,并进上一组
      previous.activities.push(activity)
      continue
    }

    if (at > cursor) segments.push({ kind: 'text', text: text.slice(cursor, at) })
    segments.push({ kind: 'tools', activities: [activity] })
    cursor = at
  }

  if (cursor < text.length) segments.push({ kind: 'text', text: text.slice(cursor) })
  return segments
}
