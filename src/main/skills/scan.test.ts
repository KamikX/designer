import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 扫描器要面对的是**别人写的目录**,不是我们生成的。所以这里的用例大多来自
 * 真实数据里实际出现过的形态:
 *
 * - 嵌套的技能集合(`superpowers` 是个符号链接,里面装着 14 个技能)
 * - 块标量、引号、缩进续行的 frontmatter
 * - name 和目录名对不上
 *
 * 只测"能扫到规范的技能"没有意义——规范的那些本来就不会出问题。
 */

let home: string
let dataDir: string
/** 内置技能的根。指向一个空的临时目录,把随应用发布的那几个隔离掉 */
let builtinHome: string

vi.mock('os', async (orig) => {
  const actual = await orig<typeof import('os')>()
  return { ...actual, homedir: () => home }
})
vi.mock('../paths', () => ({
  get DATA_DIR() {
    return dataDir
  }
}))
/*
 * 内置技能也要隔离掉。不 mock 的话 builtinRoot() 会退回 cwd,把仓库里真实的
 * resources/skills 扫进来——用例断言"只有 1 个技能"就会莫名其妙地变成 7 个,
 * 而且看不出和内置技能有关。
 */
vi.mock('electron', () => ({
  default: {
    app: {
      getAppPath: () => builtinHome
    }
  }
}))

function writeSkill(root: string, name: string, frontmatter: string, body = '# 正文'): void {
  const dir = join(root, name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'SKILL.md'), `---\n${frontmatter}\n---\n\n${body}\n`)
}

let agents: string

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'skills-home-'))
  dataDir = mkdtempSync(join(tmpdir(), 'skills-data-'))
  builtinHome = mkdtempSync(join(tmpdir(), 'skills-builtin-'))
  agents = join(home, '.agents', 'skills')
  mkdirSync(agents, { recursive: true })
  vi.resetModules()
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
  rmSync(dataDir, { recursive: true, force: true })
  rmSync(builtinHome, { recursive: true, force: true })
})

async function scan(): Promise<import('./scan').FileSkill[]> {
  const { scanSkills } = await import('./scan')
  return scanSkills()
}

describe('frontmatter 的各种真实写法', () => {
  it('最简单的键值', async () => {
    writeSkill(agents, 'vue', 'name: vue\ndescription: Vue 3. Use when writing SFCs.')
    const out = await scan()
    expect(out).toHaveLength(1)
    expect(out[0].description).toBe('Vue 3. Use when writing SFCs.')
  })

  it('缩进续行(实际文件里最常见的写法)', async () => {
    writeSkill(
      agents,
      'nuxt',
      'name: nuxt\ndescription: Nuxt 4 framework,\n  auto-imports and layers. Use when building Nuxt apps.'
    )
    const out = await scan()
    expect(out[0].description).toContain('auto-imports and layers')
  })

  it('块标量', async () => {
    writeSkill(
      agents,
      'turborepo',
      'name: turborepo\ndescription: >\n  Turborepo. Use when\n  configuring pipelines.'
    )
    const out = await scan()
    expect(out[0].description).toContain('configuring pipelines')
  })

  it('嵌套 metadata 不影响解析', async () => {
    writeSkill(
      agents,
      'antfu',
      'name: antfu\ndescription: Tooling. Use when setting up projects.\nmetadata:\n  author: Anthony Fu\n  version: "2026.1.1"'
    )
    expect(await scan()).toHaveLength(1)
  })

  /** 野外常见的畸形写法,不是合法 YAML;规范的实现指南要求补救一次 */
  it('description 里没加引号的冒号能被救回来', async () => {
    writeSkill(agents, 'weird', 'name: weird\ndescription: Use when: you need this thing')
    const out = await scan()
    expect(out).toHaveLength(1)
    expect(out[0].description).toContain('you need this thing')
  })
})

describe('该跳过的', () => {
  it('没有 SKILL.md 的目录不算技能', async () => {
    mkdirSync(join(agents, 'not-a-skill'), { recursive: true })
    expect(await scan()).toHaveLength(0)
  })

  it('没有 frontmatter 的跳过', async () => {
    const dir = join(agents, 'plain')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'SKILL.md'), '# 只是一个 markdown\n')
    expect(await scan()).toHaveLength(0)
  })

  /** description 是模型判断该不该加载的唯一依据,缺了这条技能就是不可用的 */
  it('缺 description 的跳过', async () => {
    writeSkill(agents, 'nameonly', 'name: nameonly')
    expect(await scan()).toHaveLength(0)
  })

  it('隐藏目录不扫', async () => {
    writeSkill(agents, '.hidden', 'name: hidden\ndescription: x. Use when y.')
    expect(await scan()).toHaveLength(0)
  })
})

describe('嵌套的技能集合', () => {
  /**
   * 真实形态:~/.agents/skills/superpowers 是个符号链接,指向一个装着 14 个
   * 技能的目录。只扫一层会把它们整批漏掉。
   */
  it('目录里没有 SKILL.md 时,再往下看一层', async () => {
    const pack = join(agents, 'superpowers')
    mkdirSync(pack, { recursive: true })
    writeSkill(pack, 'brainstorming', 'name: brainstorming\ndescription: A. Use when creating.')
    writeSkill(pack, 'debugging', 'name: debugging\ndescription: B. Use when stuck.')

    const out = await scan()
    expect(out.map((s) => s.name).sort()).toEqual(['brainstorming', 'debugging'])
  })

  it('只下探一层——再深就分不清集合和 references 目录了', async () => {
    const deep = join(agents, 'a', 'b')
    mkdirSync(deep, { recursive: true })
    writeSkill(deep, 'too-deep', 'name: too-deep\ndescription: x. Use when y.')
    expect(await scan()).toHaveLength(0)
  })
})

describe('符号链接', () => {
  it('跟随指向别处的链接', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'skills-outside-'))
    writeSkill(outside, 'linked', 'name: linked\ndescription: x. Use when y.')
    symlinkSync(join(outside, 'linked'), join(agents, 'linked'))

    const out = await scan()
    expect(out.map((s) => s.name)).toContain('linked')
    rmSync(outside, { recursive: true, force: true })
  })

  it('同一个真实目录被链接两次只算一个', async () => {
    writeSkill(agents, 'real', 'name: real\ndescription: x. Use when y.')
    symlinkSync(join(agents, 'real'), join(agents, 'alias'))
    // 去重按 realpath,所以别名那份不会重复出现
    expect(await scan()).toHaveLength(1)
  })
})

describe('name 与目录名', () => {
  it('不一致时以目录名为准,但留下警告', async () => {
    writeSkill(agents, 'actual-dir', 'name: something-else\ndescription: x. Use when y.')
    const out = await scan()
    // 激活时是按名字找目录的,信 frontmatter 会找不到
    expect(out[0].name).toBe('actual-dir')
    expect(out[0].warning).toContain('不一致')
  })

  it('缺 name 时用目录名,也留警告', async () => {
    writeSkill(agents, 'no-name', 'description: x. Use when y.')
    const out = await scan()
    expect(out[0].name).toBe('no-name')
    expect(out[0].warning).toContain('缺少 name')
  })
})

describe('多来源与优先级', () => {
  it('应用目录覆盖全局同名技能', async () => {
    const appSkills = join(dataDir, 'skills')
    mkdirSync(appSkills, { recursive: true })
    writeSkill(agents, 'vue', 'name: vue\ndescription: 全局版. Use when a.')
    writeSkill(appSkills, 'vue', 'name: vue\ndescription: 应用版. Use when a.')

    const out = await scan()
    expect(out).toHaveLength(1)
    // 用户为这个应用定制时,不必去改跨工具共享的那份
    expect(out[0].description).toContain('应用版')
    expect(out[0].source).toBe('app')
  })

  it('~/.claude/skills 也扫——大量现存技能装在那里', async () => {
    const claude = join(home, '.claude', 'skills')
    mkdirSync(claude, { recursive: true })
    writeSkill(claude, 'legacy', 'name: legacy\ndescription: x. Use when y.')

    const out = await scan()
    expect(out.map((s) => s.name)).toContain('legacy')
    expect(out.find((s) => s.name === 'legacy')?.source).toBe('claude')
  })

  it('目录不存在时不报错', async () => {
    rmSync(agents, { recursive: true, force: true })
    expect(await scan()).toEqual([])
  })
})

describe('授权范围', () => {
  it('每个技能目录都成为一个只读 root,否则 references 读不了', async () => {
    writeSkill(agents, 'vue', 'name: vue\ndescription: x. Use when y.')
    const { skillRoots } = await import('./scan')
    const roots = skillRoots(await scan())

    expect(roots).toHaveLength(1)
    expect(roots[0].path).toBe(join(agents, 'vue'))
    // 前缀标明来源,和用户真正授权的目录区分开
    expect(roots[0].id).toBe('skill:vue')
  })
})

describe('内置项目管理技能(builtin-pm)', () => {
  it('按分类目录嵌套扫描,来源标记为 builtin-pm', async () => {
    const pmRoot = join(builtinHome, 'resources', 'skills-pm', 'execution')
    writeSkill(pmRoot, 'create-prd', 'name: create-prd\ndescription: 编写 PRD')
    writeSkill(pmRoot, 'user-stories', 'name: user-stories\ndescription: 用户故事')

    const skills = await scan()
    const prd = skills.find((s) => s.name === 'create-prd')
    expect(prd?.source).toBe('builtin-pm')
    expect(skills.find((s) => s.name === 'user-stories')?.source).toBe('builtin-pm')
  })

  it('用户目录的同名技能覆盖内置项目管理技能', async () => {
    writeSkill(
      join(builtinHome, 'resources', 'skills-pm', 'execution'),
      'create-prd',
      'name: create-prd\ndescription: 内置版'
    )
    writeSkill(agents, 'create-prd', 'name: create-prd\ndescription: 用户版')

    const skills = await scan()
    const prd = skills.filter((s) => s.name === 'create-prd')
    expect(prd).toHaveLength(1)
    expect(prd[0].source).toBe('agents')
    expect(prd[0].description).toBe('用户版')
  })
})
