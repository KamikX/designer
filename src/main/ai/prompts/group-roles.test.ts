import { describe, expect, it } from 'vitest'
import { firstMention, nextMention } from '../../../shared/group-mentions'
import { GROUP_ROLES, roleTemplates } from './group-roles'

/**
 * @ 接力的路由解析。错了链条要么断(接不到下一棒)要么疯
 * (两个角色互相 @ 打转),而且都是运行时才看得见的错。
 */

const PM_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV'
const UI_ID = '01BX5ZZKBKACTAV9WEVGEMMVRZ'
const BE_ID = '01KYDQZR8VGYDVT4B8V8439EAH'
const QA_ID = '01J00000000000000000000000'
const MEMBERS = [
  { id: PM_ID, name: '产品经理' },
  { id: UI_ID, name: 'UI设计师' },
  { id: BE_ID, name: '后端工程师' },
  { id: '01J00000000000000000000001', name: '前端工程师' },
  { id: QA_ID, name: '测试工程师' }
]

describe('roleTemplates:建群编辑器拿到的模板', () => {
  it('预勾选技能要透传(曾经在这里被剥掉,编辑器永远拿不到默认技能)', () => {
    const fe = roleTemplates().find((role) => role.id === 'fe')
    expect(fe?.skillIds).toContain('antdv-next')
  })

  it('返回的是副本:改模板数组不能污染 GROUP_ROLES', () => {
    const pm = roleTemplates().find((role) => role.id === 'pm')
    pm?.skillIds?.push('入侵技能')
    expect(GROUP_ROLES.find((role) => role.id === 'pm')?.skillIds).not.toContain('入侵技能')
  })
})

describe('firstMention:用户消息里的第一棒', () => {
  it('识别 @产品经理', () => {
    expect(firstMention('@产品经理 我要做一个记账 App', MEMBERS)).toBe(PM_ID)
  })

  it('@ 了不在群里的角色不算', () => {
    expect(
      firstMention(
        '@测试工程师 看看',
        MEMBERS.filter((role) => [PM_ID, UI_ID].includes(role.id))
      )
    ).toBeNull()
  })

  it('没 @ 任何人 → null(只是留言,不启动链条)', () => {
    expect(firstMention('大家好', MEMBERS)).toBeNull()
  })

  it('多个 @ 取第一个命中的成员', () => {
    expect(firstMention('@UI设计师 然后 @产品经理', MEMBERS)).toBe(UI_ID)
  })
})

describe('nextMention:agent 产出里的下一棒', () => {
  it('末尾移交生效', () => {
    const text = '# 需求文档\n\n……正文……\n\n@UI设计师 请基于以上需求出交互与配色方案'
    expect(nextMention(text, MEMBERS, PM_ID)).toBe(UI_ID)
  })

  it('@用户 显式收链', () => {
    expect(nextMention('# 测试用例\n\n……\n\n@用户 全链路完成,请验收', MEMBERS, QA_ID)).toBeNull()
  })

  it('不能 @ 自己(防自转)', () => {
    expect(nextMention('……\n@产品经理 继续', MEMBERS, PM_ID)).toBeNull()
  })

  it('正文开头对上一位的回应不算移交(只看末尾几行)', () => {
    const lines = ['@产品经理 收到你的需求文档。', '# UI 设计', ...Array(10).fill('正文'), '完。']
    expect(nextMention(lines.join('\n'), MEMBERS, UI_ID)).toBeNull()
  })

  it('被 @ 的角色不在群里 → 收链', () => {
    expect(
      nextMention(
        '……\n@后端工程师 请设计表结构',
        MEMBERS.filter((role) => [PM_ID, UI_ID].includes(role.id)),
        UI_ID
      )
    ).toBeNull()
  })
})
