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

  it('craft-color 只使用 theme contract 的颜色 token，不另造旧命名轨道', () => {
    const color = readSkill('craft-color')

    expect(color).toMatch(/--color-bg/)
    expect(color).toMatch(/--color-surface/)
    expect(color).toMatch(/--color-raised/)
    expect(color).toMatch(/--color-sunken/)
    expect(color).toMatch(/--color-ink/)
    expect(color).toMatch(/--color-ink-muted/)
    expect(color).toMatch(/--color-line/)
    expect(color).toMatch(/--color-line-strong/)
    expect(color).toMatch(/--color-brand-500/)
    expect(color).toMatch(/--color-brand-600/)
    expect(color).toMatch(/--color-focus/)
    expect(color).toMatch(/--color-success/)
    expect(color).toMatch(/--color-warning/)
    expect(color).toMatch(/--color-danger/)
    expect(color).toMatch(/--color-info/)
    expect(color).not.toMatch(
      /(^|[^-\w])--(?:bg|surface|fg|muted|border|accent|success|warn|danger)\b/m
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

  it.each(['target-web', 'target-landing'])(
    '%s 只约束页面结构，视觉只能来自 StyleBrief 或上游六维 fallback',
    (target) => {
      const skill = readSkill(target)

      expect(skill).toMatch(/结构.*不决定.*视觉|不决定.*视觉.*结构/)
      expect(skill).toMatch(/StyleBrief/)
      expect(skill).toMatch(/六维 fallback|fallback.*六维/)
      expect(skill).toMatch(/target.*不.*(?:新增|生成|自建).*fallback/i)
      expect(skill).not.toMatch(/连续两个项目不许选同一组/)
      expect(skill).not.toMatch(/可信专业\(默认\)|左对齐大字\(默认\)|浅色描边\(默认\)/)
      expect(skill).not.toMatch(
        /(?:气质|密度|侧栏|首屏形态|明暗|卡片|圆角|品牌色)[^\n]{0,40}\(默认\)/
      )
      expect(skill).not.toMatch(/2-4px|8px|12px\+|品牌色注入|bg-brand-500/)
      expect(skill).not.toMatch(
        /320px|240px|66ch|2px 竖条|左对齐首屏|居中首屏|三栏特性|相邻区块不得同版式|版式家族/
      )
    }
  )

  it('antdv-theme 将 StyleBrief 翻译为开放 token 决策，而非强制选配方', () => {
    const antdv = readSkill('antdv-theme')

    expect(antdv).toMatch(/StyleBrief.*优先|StyleBrief/)
    expect(antdv).toMatch(/algorithm.*seed.*component|算法.*seed.*组件/i)
    expect(antdv).toMatch(/colorPrimary.*theme\.css|theme\.css.*colorPrimary/)
    expect(antdv).not.toMatch(/风格配方:选一组|选一组/)
    expect(antdv).not.toMatch(/默认选项/)
  })

  it('target-mobile 由 StyleBrief 和目标平台决定设备呈现，未知平台使用中性视口', () => {
    const mobile = readSkill('target-mobile')

    expect(mobile).toMatch(/StyleBrief/)
    expect(mobile).toMatch(/中性.*自适应.*移动视口/)
    expect(mobile).toMatch(/iOS.*按需参考/)
    expect(mobile).not.toMatch(/iOS\(默认\)|机框骨架\(直接抄|home indicator 永远要/)
    expect(mobile).not.toMatch(/w-\[390px\]|h-\[844px\]|rounded-\[56px\]/)
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

  it('antdv 主题示例通过 DOM computed style 将任意 CSS 长度解析为像素', () => {
    const antdv = readSkill('antdv-theme')

    expect(antdv).toMatch(/getComputedStyle/)
    expect(antdv).toMatch(/theme\.darkAlgorithm/)
    expect(antdv).toMatch(/document\.createElement/)
    expect(antdv).toMatch(/probe\.style\.width\s*=\s*value/)
    expect(antdv).toMatch(/document\.body\.append\(probe\)/)
    expect(antdv).toMatch(/getComputedStyle\(probe\)\.(?:width|inlineSize)/)
    expect(antdv).toMatch(/Number\.isFinite/)
    expect(antdv).toMatch(/probe\.remove/)
    expect(antdv).toMatch(/`px`、`rem`、`clamp\(\)` 和 `var\(\)`/)
    expect(antdv).not.toMatch(/Number\.parseFloat\(readToken/)
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

  it('anti-slop 只在 StyleBrief 缺省时用模板化特征做 fallback 检查', () => {
    const antiSlop = readSkill('craft-anti-slop')

    expect(antiSlop).toMatch(/StyleBrief/)
    expect(antiSlop).toMatch(/fallback/)
    expect(antiSlop).not.toMatch(/七宗罪\(出现任何一条都要重做\)/)
    expect(antiSlop).not.toMatch(/一个平面加上有意图的字排,任何时候都赢它/)
  })

  it('motion 由 StyleBrief 决定手感，固定数值只可作为范围示意', () => {
    const motion = readSkill('craft-motion')

    expect(motion).toMatch(/StyleBrief/)
    expect(motion).toMatch(/prefers-reduced-motion/)
    expect(motion).not.toMatch(/\*\*120ms\*\*|\*\*200ms\*\*|\*\*140ms\*\*/)
    expect(motion).not.toMatch(/scale\(0\.97\)|translateY\(-1px\)|\* 80ms/)
  })
})
