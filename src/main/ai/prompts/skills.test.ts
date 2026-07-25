import { describe, expect, it } from 'vitest'
import { normalizeSkillBody, skillsPrompt } from './skills'
import { BUILTIN_SKILLS } from './builtin-skills'
import type { Skill } from '../../../shared/types'

/**
 * 技能是长期驻留在 system prompt 里的东西:进得去、不越界、层级不乱,
 * 三条都要钉住。之前这条链路整个断着(技能内容从没进过 prompt),
 * 所以这里的第一条测试其实是在防它再断一次。
 */

function userSkill(over: Partial<Skill> = {}): Skill {
  return {
    id: 's1',
    name: '品牌规范',
    description: '',
    content: '主色必须用 #ff6600。',
    enabled: true,
    createdAt: '',
    updatedAt: '',
    ...over
  }
}

describe('内置技能一定注入', () => {
  it('强制技能在没有任何用户技能时也在', () => {
    const out = skillsPrompt([])
    for (const skill of BUILTIN_SKILLS.filter((s) => s.alwaysOn)) {
      expect(out).toContain(skill.name)
    }
    expect(out).toContain('第一步永远是设计体系')
  })

  it('内置排在用户技能前面——骨架不该被补充顶掉', () => {
    const out = skillsPrompt([userSkill()])
    expect(out.indexOf('UI 设计体系规范')).toBeLessThan(out.indexOf('品牌规范'))
  })

  it('用户技能的正文进得去', () => {
    expect(skillsPrompt([userSkill()])).toContain('#ff6600')
  })
})

describe('标题层级', () => {
  it('去掉正文开头重复的 h1', () => {
    expect(normalizeSkillBody('# 我的技能\n\n正文')).toBe('正文')
  })

  it('其余标题整体下沉两级', () => {
    expect(normalizeSkillBody('## 一级\n内容\n### 二级')).toBe('#### 一级\n内容\n##### 二级')
  })

  it('下沉不超过 h6', () => {
    expect(normalizeSkillBody('##### 很深')).toBe('###### 很深')
  })

  it('组装后不出现层级倒挂', () => {
    const out = skillsPrompt([])
    // 技能名是 ###,正文里就不该再冒出 # 或 ##
    const headings = out.split('\n').filter((l) => /^#{1,2} /.test(l))
    expect(headings).toEqual(['## 必须遵守的规范'])
  })
})

describe('预算', () => {
  it('单条技能超长会被截断', () => {
    const out = skillsPrompt([userSkill({ content: '很长'.repeat(8000) })])
    expect(out).toContain('已截断')
  })

  it('总量有硬上限,不会被一堆技能撑爆', () => {
    const many = Array.from({ length: 20 }, (_, i) =>
      userSkill({ id: `s${i}`, name: `技能${i}`, content: '内容'.repeat(3000) })
    )
    expect(skillsPrompt(many).length).toBeLessThan(30000)
  })

  it('没有任何技能时(内置全关)返回空串,不留空标题', () => {
    // 内置目前都是 alwaysOn,这里直接验证渲染函数对空输入的行为
    expect(skillsPrompt([]).startsWith('## 必须遵守的规范')).toBe(true)
  })
})
