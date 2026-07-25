import { describe, expect, it } from 'vitest'
import { describeNow } from './time-tools'

/**
 * 固定一个时刻来测,不读系统时间——否则只能断言"没报错",那等于没测。
 *
 * 2026-07-25T09:45:00Z 是个星期六。挑它是因为跨时区之后星期几会变(纽约
 * 那天是 05:45 还是同一天,但东京已经是 18:45),正好能验证换算。
 */
const T = new Date('2026-07-25T09:45:00Z')

describe('基本格式', () => {
  it('日期、时间、星期几都给到', () => {
    const out = describeNow(T, 'UTC')
    expect(out).toContain('2026-07-25')
    expect(out).toContain('09:45:00')
    expect(out).toContain('星期六')
  })

  it('同时给 ISO——模型做日期计算时不用二次解析可读格式', () => {
    expect(describeNow(T, 'UTC')).toContain('2026-07-25T09:45:00.000Z')
  })

  it('带上时区名和偏移,跨时区换算要用', () => {
    const out = describeNow(T, 'Asia/Shanghai')
    expect(out).toContain('Asia/Shanghai')
    expect(out).toContain('UTC+08:00')
  })
})

describe('时区换算', () => {
  it('东八区是当天下午', () => {
    expect(describeNow(T, 'Asia/Shanghai')).toContain('17:45:00')
  })

  it('纽约是当天凌晨,日期不变', () => {
    const out = describeNow(T, 'America/New_York')
    expect(out).toContain('05:45:00')
    expect(out).toContain('2026-07-25')
  })

  /** 跨了日界线的时区,日期会不一样——星期几必须跟着变,不能拿 UTC 那天的 */
  it('跨日期时星期几跟着走', () => {
    // 这一刻 UTC 是周六 09:45,而奥克兰(UTC+12)已经是周六 21:45
    const auckland = describeNow(T, 'Pacific/Auckland')
    expect(auckland).toContain('21:45:00')
    expect(auckland).toContain('星期六')

    // 往前挪 12 小时:UTC 还是周五 21:45,奥克兰已经跨到周六
    const earlier = describeNow(new Date('2026-07-24T21:45:00Z'), 'Pacific/Auckland')
    expect(earlier).toContain('2026-07-25')
    expect(earlier).toContain('星期六')
  })

  it('UTC 的偏移写成 UTC+00:00,不是裸的 GMT', () => {
    // longOffset 在 UTC 上只返回 "GMT",不补的话看着像缺了东西
    expect(describeNow(T, 'UTC')).toContain('UTC+00:00')
  })
})

describe('夏令时', () => {
  /**
   * 偏移不能写死。纽约夏天 UTC-04:00、冬天 UTC-05:00,如果哪天有人图省事
   * 缓存了偏移量,这条会红。
   */
  it('同一个时区在冬夏偏移不同', () => {
    const summer = describeNow(new Date('2026-07-25T12:00:00Z'), 'America/New_York')
    const winter = describeNow(new Date('2026-01-25T12:00:00Z'), 'America/New_York')
    expect(summer).toContain('UTC-04:00')
    expect(winter).toContain('UTC-05:00')
  })
})

describe('异常输入', () => {
  it('非法时区抛错,由调用方转成人话', () => {
    // 不能静默退回本机时区:那会给出一个看着正常、实际错误的时间
    expect(() => describeNow(T, '火星/基地一号')).toThrow()
  })

  it('不传时区时用本机时区,不报错', () => {
    expect(describeNow(T)).toContain('2026-07-25')
  })
})
