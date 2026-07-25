import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { CRAFT_CORE } from '../ai/prompts/craft-core'
import { stackPrompt } from '../ai/prompts/stacks'
import { targetContractPrompt } from '../ai/prompts/targets'

const skillRoot = join(process.cwd(), 'resources', 'skills')

function readSkill(name: string): string {
  return readFileSync(join(skillRoot, name, 'SKILL.md'), 'utf8')
}

describe('内置设计技能的 StyleBrief 契约', () => {
  it('design-seed 以 StyleBrief 生成完整主题，而非复制固定母版', () => {
    const seed = readSkill('design-seed')

    expect(seed).toMatch(/StyleBrief/)
    expect(seed).toMatch(/生成.*完整.*theme\.css|完整.*theme\.css/)
    expect(seed).toMatch(/theme-contract\.md/)
    expect(seed).not.toMatch(/assets\/theme\.css/)
    expect(seed).not.toMatch(/只改这几个|复制.*theme\.css/)
    expect(seed).not.toMatch(/references\/layouts\.md/)
  })

  it('theme contract 只定义语义接口，不携带旧母版的具体视觉值', () => {
    const contract = join(skillRoot, 'design-seed', 'references', 'theme-contract.md')

    expect(existsSync(contract)).toBe(true)
    const content = readFileSync(contract, 'utf8')
    expect(content).toMatch(/semantic token|语义 token/i)
    expect(content).toMatch(/映射|mapping/i)
    expect(content).not.toMatch(
      /#c96442|#b45a3b|#faf9f7|Source Serif Pro|96px|56px|32px|44px|10px/i
    )
  })

  it('target-admin 保持运营信息架构，但由 StyleBrief 决定视觉实现', () => {
    const admin = readSkill('target-admin')

    expect(admin).toMatch(/StyleBrief.*优先|StyleBrief/)
    expect(admin).toMatch(/表格四态/)
    expect(admin).toMatch(/危险操作/)
    expect(admin).not.toMatch(/克制到近乎无趣/)
    expect(admin).not.toMatch(/左侧栏\(默认|浅色\(默认|主按钮\(默认/)
  })

  it('antdv-theme 将 StyleBrief 翻译为开放 token 决策，而非强制选配方', () => {
    const antdv = readSkill('antdv-theme')

    expect(antdv).toMatch(/StyleBrief.*优先|StyleBrief/)
    expect(antdv).toMatch(/algorithm.*seed.*component|算法.*seed.*组件/i)
    expect(antdv).toMatch(/colorPrimary.*theme\.css|theme\.css.*colorPrimary/)
    expect(antdv).not.toMatch(/风格配方:选一组|选一组/)
    expect(antdv).not.toMatch(/默认选项/)
  })
})

describe('StyleBrief 不被通用审美护栏覆盖', () => {
  it('常驻 craft prompt 只保留可访问性与诚信底线，不固定颜色、字体或强调色额度', () => {
    expect(CRAFT_CORE).toMatch(/StyleBrief/)
    expect(CRAFT_CORE).not.toMatch(/强调色一屏最多两处|不要纯黑纯白|标题字体\s*≠\s*正文字体/)
  })

  it('中后台角色保留效率取向，不把无趣作为审美结论', () => {
    const admin = targetContractPrompt(['admin'])
    expect(admin).toMatch(/效率|信息架构/)
    expect(admin).not.toMatch(/克制到近乎无趣|装饰即噪音/)
  })

  it('组件库提示要求从 StyleBrief 与 theme.css 做开放映射，不再引用封闭配方', () => {
    const prompt = stackPrompt('vue3', ['antdv-next'])
    expect(prompt).toMatch(/StyleBrief/)
    expect(prompt).toMatch(/theme\.css/)
    expect(prompt).not.toMatch(/六套风格配方|配方见/)
  })

  it('antdv 主题示例可直接读取项目 CSS token，且不调用虚构 helper', () => {
    const antdv = readSkill('antdv-theme')
    expect(antdv).toMatch(/getComputedStyle/)
    expect(antdv).toMatch(/theme\.darkAlgorithm/)
    expect(antdv).not.toMatch(/readProjectThemeTokens/)
  })

  it('通用 craft 技能把具体视觉规则降为 StyleBrief 可覆盖的建议', () => {
    const admin = readSkill('target-admin')
    const typography = readSkill('craft-typography')
    const color = readSkill('craft-color')

    expect(admin).not.toMatch(/12px|小圆点|≥10 行|有就删/)
    expect(typography).toMatch(/StyleBrief/)
    expect(typography).not.toMatch(/标题字体\s*≠\s*正文字体/)
    expect(color).toMatch(/StyleBrief/)
    expect(color).not.toMatch(
      /一屏最多出现 2 处|抬起来的表面和文字走暖|凹下去的填充和所有描边走冷|没有纯黑纯白/
    )
  })
})
