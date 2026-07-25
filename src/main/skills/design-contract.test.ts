import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'

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
