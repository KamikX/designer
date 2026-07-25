import { describe, expect, it } from 'vitest'
import { firstMention, nextMention } from './group-roles'

/**
 * @ 接力的路由解析。错了链条要么断(接不到下一棒)要么疯
 * (两个角色互相 @ 打转),而且都是运行时才看得见的错。
 */

const ALL = ['pm', 'ui', 'be', 'fe', 'qa']

describe('firstMention:用户消息里的第一棒', () => {
  it('识别 @产品经理', () => {
    expect(firstMention('@产品经理 我要做一个记账 App', ALL)).toBe('pm')
  })

  it('@ 了不在群里的角色不算', () => {
    expect(firstMention('@测试工程师 看看', ['pm', 'ui'])).toBeNull()
  })

  it('没 @ 任何人 → null(只是留言,不启动链条)', () => {
    expect(firstMention('大家好', ALL)).toBeNull()
  })

  it('多个 @ 取第一个命中的成员', () => {
    expect(firstMention('@UI设计师 然后 @产品经理', ALL)).toBe('ui')
  })
})

describe('nextMention:agent 产出里的下一棒', () => {
  it('末尾移交生效', () => {
    const text = '# 需求文档\n\n……正文……\n\n@UI设计师 请基于以上需求出交互与配色方案'
    expect(nextMention(text, ALL, 'pm')).toBe('ui')
  })

  it('@用户 显式收链', () => {
    expect(nextMention('# 测试用例\n\n……\n\n@用户 全链路完成,请验收', ALL, 'qa')).toBeNull()
  })

  it('不能 @ 自己(防自转)', () => {
    expect(nextMention('……\n@产品经理 继续', ALL, 'pm')).toBeNull()
  })

  it('正文开头对上一位的回应不算移交(只看末尾几行)', () => {
    const lines = ['@产品经理 收到你的需求文档。', '# UI 设计', ...Array(10).fill('正文'), '完。']
    expect(nextMention(lines.join('\n'), ALL, 'ui')).toBeNull()
  })

  it('被 @ 的角色不在群里 → 收链', () => {
    expect(nextMention('……\n@后端工程师 请设计表结构', ['pm', 'ui'], 'ui')).toBeNull()
  })
})
