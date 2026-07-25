import { describe, expect, it } from 'vitest'
import { skillCatalog } from './catalog'
import type { FileSkill } from './scan'

/**
 * 目录是渐进披露的第一层,也是唯一每轮都进上下文的那层。它的取舍只有一条:
 * **宁可把描述削短,也不要丢掉整条技能** —— 丢掉的那条模型永远不会知道它存在,
 * 于是它会说"我没有这个能力",而其实有。
 */

const skill = (name: string, description: string): FileSkill => ({
  name,
  description,
  path: `/home/u/.agents/skills/${name}/SKILL.md`,
  dir: `/home/u/.agents/skills/${name}`,
  source: 'agents'
})

describe('基本形状', () => {
  it('没有技能时返回空串,不占位置', () => {
    expect(skillCatalog([])).toBe('')
  })

  it('用规范里的 available_skills 结构', () => {
    const out = skillCatalog([skill('vue', 'Vue 3. Use when writing SFCs.')])
    expect(out).toContain('<available_skills>')
    expect(out).toContain('<name>vue</name>')
    expect(out).toContain('<description>Vue 3. Use when writing SFCs.</description>')
  })

  /** location 不是装饰:模型据此解析正文里的 references/xxx 相对路径 */
  it('必须带 location', () => {
    const out = skillCatalog([skill('vue', 'x')])
    expect(out).toContain('<location>/home/u/.agents/skills/vue/SKILL.md</location>')
  })

  it('提示模型按触发条件加载,而不是全读', () => {
    const out = skillCatalog([skill('vue', 'x')])
    expect(out).toContain('activate_skill')
    expect(out).toContain('触发条件')
  })
})

describe('预算', () => {
  const many = Array.from({ length: 60 }, (_, i) =>
    skill(`skill-${i}`, 'D'.repeat(600) + ' Use when something happens.')
  )

  it('超预算时**削短描述,不丢条目**', () => {
    const out = skillCatalog(many, 16_000)
    // 60 条一条都不能少
    for (let i = 0; i < 60; i++) expect(out).toContain(`<name>skill-${i}</name>`)
    expect(out).toContain('…')
  })

  it('上下文越大,描述留得越长', () => {
    // 用 20 条而不是 60 条:技能太多时两边都会触到描述下限,产出相同——
    // 那是下限在正常工作,不是预算没生效
    const some = many.slice(0, 20)
    expect(skillCatalog(some, 200_000).length).toBeGreaterThan(skillCatalog(some, 16_000).length)
  })

  it('不知道上下文大小时也有个上限,不会无限膨胀', () => {
    expect(skillCatalog(many).length).toBeLessThan(20_000)
  })

  it('描述削短有下限——再短就看不出触发条件,那这条等于没有', () => {
    const out = skillCatalog(many, 8_000)
    const descriptions = [...out.matchAll(/<description>(.*?)<\/description>/g)].map((m) => m[1])
    expect(descriptions.length).toBe(60)
    for (const d of descriptions) expect(d.length).toBeGreaterThanOrEqual(80)
  })

  it('装得下就一个字不动', () => {
    const few = [skill('a', 'Short. Use when a.'), skill('b', 'Short. Use when b.')]
    const out = skillCatalog(few, 200_000)
    expect(out).toContain('Short. Use when a.')
    expect(out).not.toContain('…')
  })
})
