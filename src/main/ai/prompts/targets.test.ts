import { join } from 'path'
import { describe, expect, it } from 'vitest'
import {
  renderCompatNote,
  renderTargetTemplates,
  routeActiveTargets,
  targetContractPrompt
} from './targets'
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

describe('routeActiveTargets 活动目标路由', () => {
  const FILES = (...paths: string[]): { path: string }[] => paths.map((path) => ({ path }))

  it('用户本轮明确端类型时优先', () => {
    const route = routeActiveTargets({
      targets: ['admin', 'landing', 'web'],
      userText: '给中后台加一个 RBAC 权限管理页',
      currentFiles: FILES('landing.html', 'web.html')
    })
    expect(route.active).toEqual(['admin'])
    expect(route.compat).toEqual(['landing', 'web'])
  })

  it('本轮没点名时按 manifest/路径唯一确定', () => {
    const route = routeActiveTargets({
      targets: ['admin', 'landing'],
      userText: '把表格列宽调一下',
      currentFiles: FILES('admin.html', 'css/admin.css')
    })
    expect(route.active).toEqual(['admin'])
  })

  it('项目只有一个端时直接用它', () => {
    const route = routeActiveTargets({
      targets: ['mobile'],
      userText: '随便改改',
      currentFiles: []
    })
    expect(route.active).toEqual(['mobile'])
    expect(route.compat).toEqual([])
  })

  it('无法唯一确定时不注入任何完整模板,全部走兼容契约', () => {
    const route = routeActiveTargets({
      targets: ['admin', 'landing'],
      userText: '整体再精致一点',
      currentFiles: FILES('admin.html', 'landing.html')
    })
    expect(route.active).toEqual([])
    expect(route.compat).toEqual(['admin', 'landing'])
  })

  it('admin-only 轮次:完整 admin 模板,landing/web 只留兼容说明', () => {
    const route = routeActiveTargets({
      targets: ['admin', 'landing', 'web'],
      userText: '继续完善后台的角色列表',
      currentFiles: FILES('admin.html', 'landing.html', 'web.html')
    })
    expect(route.active).toEqual(['admin'])
    const note = renderCompatNote(route.compat)
    expect(note).toContain('落地页')
    expect(note).toContain('Web 应用')
    expect(note).not.toContain('模板正文')
  })
})
