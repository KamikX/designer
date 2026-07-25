import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { renderTargetTemplates, targetContractPrompt } from './targets'
import { buildSystemPrompt } from './index'
import { loadTargetTemplates } from '../../skills/targets'
import type { FileSkill } from '../../skills/scan'
import type { Project } from '../../../shared/types'

function builtinSkill(name: string): FileSkill {
  const dir = join(process.cwd(), 'resources', 'skills', name)
  return {
    name,
    description: 'x',
    path: join(dir, 'SKILL.md'),
    dir,
    source: 'builtin'
  }
}

describe('targetContractPrompt', () => {
  it('没勾端就一个字都不注入', () => {
    expect(targetContractPrompt([])).toBe('')
  })

  it('单端:有角色定位,没有多端交付结构', () => {
    const out = targetContractPrompt(['mobile'])
    expect(out).toContain('移动端 App')
    expect(out).toContain('交互设计师')
    expect(out).not.toContain('多端交付结构')
  })

  it('多端:带交付结构,禁止平台切换 tab', () => {
    const out = targetContractPrompt(['mobile', 'landing'])
    expect(out).toContain('多端交付结构')
    expect(out).toContain('平台切换 tab')
  })

  it('端契约不再注入单一风格骰子', () => {
    const out = targetContractPrompt(['web'])
    expect(out).not.toContain('风格骰子')
    expect(out).not.toContain('选第')
  })
})

describe('loadTargetTemplates', () => {
  it('读内置模板并剥掉 frontmatter', () => {
    const skills = [builtinSkill('target-landing'), builtinSkill('target-mobile')]
    const out = loadTargetTemplates(skills, ['landing', 'mobile'])
    expect(out.map((t) => t.name)).toEqual(['target-landing', 'target-mobile'])
    for (const t of out) {
      expect(t.body).not.toContain('---\nname:')
      expect(t.body.length).toBeGreaterThan(200)
    }
  })

  it('技能不存在时静默跳过,不炸', () => {
    expect(loadTargetTemplates([], ['admin'])).toEqual([])
  })
})

describe('buildSystemPrompt 分区顺序', () => {
  const project = {
    id: 'p1',
    name: 't',
    stack: 'html',
    designMode: 'design',
    targets: ['landing'],
    description: '',
    settings: null,
    createdAt: '',
    updatedAt: ''
  } as Project

  it('视觉方向在端契约和模板之前，lint 在文件树之后', () => {
    const out = buildSystemPrompt(project, [], {
      mode: 'tools',
      styleBriefPrompt: '## 项目视觉方向\n\n冷灰、紧凑。',
      targetContract: targetContractPrompt(['landing']),
      targetTemplates: renderTargetTemplates([{ name: 'target-landing', body: '# 落地页模板体' }]),
      slopLint: '## 反AI味检查标记'
    })
    const contractAt = out.indexOf('本项目的端')
    const templateAt = out.indexOf('落地页模板体')
    const styleBriefAt = out.indexOf('项目视觉方向')
    const filesAt = out.indexOf('## 当前设计稿')
    const lintAt = out.indexOf('反AI味检查标记')
    expect(styleBriefAt).toBeGreaterThan(-1)
    expect(contractAt).toBeGreaterThan(-1)
    expect(contractAt).toBeGreaterThan(styleBriefAt)
    expect(templateAt).toBeGreaterThan(contractAt)
    expect(filesAt).toBeGreaterThan(templateAt)
    expect(lintAt).toBeGreaterThan(filesAt)
  })
})
