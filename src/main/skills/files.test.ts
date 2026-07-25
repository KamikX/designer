import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 「我的技能」文件层的重点不是 CRUD 本身,是**路径守卫**:name 和 rel 都来自
 * 渲染进程,必须当不可信输入。守不住的话,渲染层一个 XSS 就等于任意文件写。
 */

let dataDir: string

vi.mock('../paths', () => ({
  get DATA_DIR() {
    return dataDir
  }
}))

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'skillfs-'))
  vi.resetModules()
})
afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true })
})

async function mod(): Promise<typeof import('./files')> {
  return import('./files')
}

describe('路径守卫', () => {
  it('技能名不许带路径分隔符或以点开头', async () => {
    const { skillTree } = await mod()
    expect(() => skillTree('../escape')).toThrow()
    expect(() => skillTree('a/b')).toThrow()
    expect(() => skillTree('.hidden')).toThrow()
    expect(() => skillTree('')).toThrow()
  })

  it('rel 不许越出技能目录,也不接受绝对路径', async () => {
    const { createSkillPackage, readSkillFile, writeSkillFile } = await mod()
    createSkillPackage('demo')
    expect(() => readSkillFile('demo', '../../etc/passwd')).toThrow()
    expect(() => writeSkillFile('demo', '/tmp/x', 'x')).toThrow()
  })

  it('不能用 removeEntry 删掉技能根目录', async () => {
    const { createSkillPackage, removeSkillEntry } = await mod()
    createSkillPackage('demo')
    expect(() => removeSkillEntry('demo', '.')).toThrow()
  })
})

describe('基本读写', () => {
  it('新建技能带模板 SKILL.md,同名再建报错', async () => {
    const { createSkillPackage } = await mod()
    const skill = createSkillPackage('我的规范')
    expect(readFileSync(join(skill.dir, 'SKILL.md'), 'utf-8')).toContain('name: 我的规范')
    expect(() => createSkillPackage('我的规范')).toThrow('已存在')
  })

  it('写 → 树 → 读 → 删一条龙', async () => {
    const {
      createSkillPackage,
      mkdirSkill,
      readSkillFile,
      removeSkillEntry,
      skillTree,
      writeSkillFile
    } = await mod()
    createSkillPackage('demo')
    mkdirSkill('demo', 'references')
    writeSkillFile('demo', 'references/layouts.md', '# 版面')
    const tree = skillTree('demo')
    const dir = tree.find((n) => n.name === 'references')
    expect(dir?.type).toBe('dir')
    expect(dir?.children?.[0].path).toBe('references/layouts.md')
    expect(readSkillFile('demo', 'references/layouts.md')).toBe('# 版面')
    removeSkillEntry('demo', 'references')
    expect(skillTree('demo').find((n) => n.name === 'references')).toBeUndefined()
  })

  it('市场安装:无 frontmatter 的内容补上 frontmatter;已装同名报错', async () => {
    const { installSkillContent } = await mod()
    const skill = installSkillContent('移动端优先', '移动端设计规范', '# 内容')
    const raw = readFileSync(join(skill.dir, 'SKILL.md'), 'utf-8')
    expect(raw.startsWith('---\nname: 移动端优先')).toBe(true)
    expect(raw).toContain('# 内容')
    expect(() => installSkillContent('移动端优先', 'x', 'y')).toThrow('已安装')
  })

  it('删除技能目录后不留痕', async () => {
    const { createSkillPackage, removeSkillPackage } = await mod()
    const skill = createSkillPackage('demo')
    removeSkillPackage('demo')
    expect(existsSync(skill.dir)).toBe(false)
  })
})
