import { tool } from 'ai'
import type { ToolSet } from 'ai'
import { z } from 'zod'

/**
 * 当前时间。**默认内置,不需要任何开关。**
 *
 * 为什么值得占一个工具位:模型对"今天是几号"只有训练截止时的印象,而它经常
 * 意识不到这一点——问它今天几号,它会给一个看起来很确定的错误答案,而不是说
 * "我不知道"。凡是涉及日期的输出(版本号、变更日志、"最近三个月"、给设计稿
 * 里填的示例数据)都会跟着错。
 *
 * 取的是**本机时间**,不联网。用户的时区就是他的时区,不需要问任何人。
 */

export function buildTimeTools(): ToolSet {
  const tools = {
    get_current_time: tool({
      description:
        '获取当前日期时间(本机时区)。**凡是涉及"今天""现在""最近"的问题都先调它**,' +
        '不要凭印象猜——你的训练数据有截止时间,而用户在此刻。',
      inputSchema: z.object({
        timezone: z
          .string()
          .optional()
          .describe('IANA 时区名(如 Asia/Shanghai、America/New_York)。缺省用本机时区')
      }),
      execute: async (input) => {
        try {
          return describeNow(new Date(), input.timezone)
        } catch {
          return `错误:无法识别时区「${input.timezone}」。请用 IANA 格式,如 Asia/Shanghai。`
        }
      }
    })
  }
  return tools
}

/**
 * 格式化成一句给模型看的话。
 *
 * 同时给**可读格式和 ISO**:前者让它直接抄进文案,后者让它做日期计算时不用
 * 二次解析。星期几单独给,因为从日期反推星期是模型很容易算错的一件事。
 *
 * 抽出来收 Date 参数是为了可测——直接读 new Date() 的话,测试只能断言
 * "不报错",那等于没测。
 */
export function describeNow(now: Date, timezone?: string): string {
  const zone = timezone || Intl.DateTimeFormat().resolvedOptions().timeZone

  // 非法时区在这里抛,由调用方转成人话。放过去的话会得到一个静默错误的时间
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    weekday: 'long',
    hour12: false
  }).formatToParts(now)

  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? ''
  const date = `${get('year')}-${get('month')}-${get('day')}`
  const time = `${get('hour')}:${get('minute')}:${get('second')}`

  return [
    `当前时间:${date} ${time} ${get('weekday')}`,
    `时区:${zone}(${offsetOf(now, zone)})`,
    `ISO:${now.toISOString()}`
  ].join('\n')
}

/** 相对 UTC 的偏移,形如 UTC+08:00。模型跨时区换算时要用 */
function offsetOf(now: Date, zone: string): string {
  const name = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'longOffset' })
    .formatToParts(now)
    .find((p) => p.type === 'timeZoneName')?.value
  // longOffset 在 UTC 上返回的就是 "GMT",补成完整写法免得看着像缺了东西
  return name === 'GMT' ? 'UTC+00:00' : (name?.replace('GMT', 'UTC') ?? '未知')
}
