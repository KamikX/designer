import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 安装写的是**用户机器上的持久文件**,而内容来自模型(或模型从网上抓的)。所以
 * 校验的重点不是"能不能装上",是**不合格的东西必须被挡住**:
 *
 * - 缺 description 的技能永远不会被激活(目录里没有触发条件),装了等于制造
 *   一个永远沉默的文件
 * - name 不合规会让扫描时目录名和 frontmatter 对不上,后续一连串警告
 */

let home: string
let dataDir: string

vi.mock('os', async (orig) => {
  const actual = await orig<typeof import('os')>()
  return { ...actual, homedir: () => home }
})
vi.mock('../paths', () => ({
  get DATA_DIR() {
    return dataDir
  }
}))

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'inst-home-'))
  dataDir = mkdtempSync(join(tmpdir(), 'inst-data-'))
  vi.resetModules()
})
afterEach(() => {
  rmSync(home, { recursive: true, force: true })
  rmSync(dataDir, { recursive: true, force: true })
})

async function install(
  content: string,
  scope: 'global' | 'app' = 'app'
): Promise<import('./install').InstallResult> {
  const { installSkill } = await import('./install')
  return installSkill(content, scope)
}

const good = `---
name: my-skill
description: Does a thing. Use when you need that thing.
---

# 正文
`

describe('装到哪', () => {
  it('global 写进 ~/.agents/skills —— 跨工具共享的位置', async () => {
    const out = await install(good, 'global')
    expect(out.ok).toBe(true)
    expect(out.dir).toBe(join(home, '.agents', 'skills', 'my-skill'))
    expect(existsSync(join(out.dir!, 'SKILL.md'))).toBe(true)
  })

  it('app 写进应用目录,不影响别的工具', async () => {
    const out = await install(good, 'app')
    expect(out.dir).toBe(join(dataDir, 'skills', 'my-skill'))
  })

  it('内容原样写入,不做任何改写', async () => {
    const out = await install(good)
    expect(readFileSync(join(out.dir!, 'SKILL.md'), 'utf-8')).toBe(good)
  })

  it('目录不存在时自动建', async () => {
    expect(await install(good, 'global')).toMatchObject({ ok: true })
  })
})

describe('该拒绝的', () => {
  it('没有 frontmatter', async () => {
    const out = await install('# 只是一篇 markdown')
    expect(out.ok).toBe(false)
    expect(out.error).toContain('frontmatter')
  })

  it('缺 name', async () => {
    const out = await install('---\ndescription: x. Use when y.\n---\n')
    expect(out.ok).toBe(false)
    expect(out.error).toContain('name')
  })

  /** 缺了它这个技能永远不会被激活——目录里没有触发条件,模型无从判断 */
  it('缺 description,并说清为什么它是必须的', async () => {
    const out = await install('---\nname: x\n---\n')
    expect(out.ok).toBe(false)
    expect(out.error).toContain('description')
    expect(out.error).toContain('唯一依据')
  })

  it('YAML 坏了', async () => {
    const out = await install('---\nname: [unclosed\n---\n')
    expect(out.ok).toBe(false)
  })
})

describe('name 的规范约束', () => {
  it.each([
    ['Upper-Case', '大写'],
    ['has space', '空格'],
    ['-leading', '连字符开头'],
    ['trailing-', '连字符结尾'],
    ['double--hyphen', '连续连字符'],
    ['under_score', '下划线']
  ])('拒绝 %s(%s)', async (name) => {
    const out = await install(`---\nname: ${name}\ndescription: x. Use when y.\n---\n`)
    expect(out.ok).toBe(false)
    expect(out.error).toContain('name')
  })

  it.each(['vue', 'antdv-next', 'a1', 'a-b-c'])('接受 %s', async (name) => {
    expect(await install(`---\nname: ${name}\ndescription: x. Use when y.\n---\n`)).toMatchObject({
      ok: true
    })
  })

  it('超过 64 字符拒绝', async () => {
    const long = 'a'.repeat(65)
    const out = await install(`---\nname: ${long}\ndescription: x. Use when y.\n---\n`)
    expect(out.ok).toBe(false)
    expect(out.error).toContain('64')
  })

  /*
   * 校验而不是自动改名:改了之后目录名和 frontmatter 里的 name 又对不上,
   * 反而制造出扫描时的那类警告。让模型按规范重写一次更干净。
   */
  it('不合规时不会"帮忙修正"成一个能用的名字', async () => {
    const out = await install('---\nname: My Skill\ndescription: x. Use when y.\n---\n')
    expect(out.ok).toBe(false)
    expect(out.dir).toBeUndefined()
  })
})
