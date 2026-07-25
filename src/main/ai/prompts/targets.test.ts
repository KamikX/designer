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

  it('端契约在稳定区(文件树之前),lint 在可变区(文件树之后)', () => {
    const out = buildSystemPrompt(project, [], {
      mode: 'tools',
      targetContract: targetContractPrompt(['landing']),
      targetTemplates: renderTargetTemplates([{ name: 'target-landing', body: '# 落地页模板体' }]),
      slopLint: '## 反AI味检查标记'
    })
    const contractAt = out.indexOf('本项目的端')
    const templateAt = out.indexOf('落地页模板体')
    const filesAt = out.indexOf('当前设计稿')
    const lintAt = out.indexOf('反AI味检查标记')
    expect(contractAt).toBeGreaterThan(-1)
    expect(templateAt).toBeGreaterThan(contractAt)
    expect(filesAt).toBeGreaterThan(templateAt)
    expect(lintAt).toBeGreaterThan(filesAt)
  })
})
