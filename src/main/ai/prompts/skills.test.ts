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

describe('内置技能不再常驻', () => {
  /*
   * 这几条以前钉的是"内置技能一定注入"。**行为是有意改掉的**:那两条内置技能
   * 的内容已经搬进 resources/skills/(craft-* 与 design-seed),由渐进披露按需
   * 加载。常驻注入四千字设计规范正是要解决的问题——不管这轮是在改一个按钮
   * 还是从头设计,都塞同样一坨,既贵又吵。
   */
  it('没有用户技能时返回空串,不再强塞设计规范', () => {
    expect(skillsPrompt([])).toBe('')
  })

  it('BUILTIN_SKILLS 里已经没有常驻项', () => {
    expect(BUILTIN_SKILLS.filter((s) => s.alwaysOn)).toEqual([])
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
    // 有用户技能时才有输出;技能名是 ###,正文里就不该再冒出 # 或 ##
    const out = skillsPrompt([userSkill({ content: '# 一级\n## 二级\n正文' })])
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

  it('没有任何技能时返回空串,不留一个孤零零的标题', () => {
    expect(skillsPrompt([])).toBe('')
  })
})
