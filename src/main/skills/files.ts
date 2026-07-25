import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} from 'fs'
import { dirname, isAbsolute, join, normalize, sep } from 'path'
import { DATA_DIR } from '../paths'
import type { InstalledSkill, SkillFileNode } from '../../shared/types'

/**
 * 「我的技能」的文件管理,全部 scoped 在 `~/.antd-designer/skills` 下。
 *
 * 这是技能的**唯一可写入口**(市场安装、新建、zip 导入、左树右编辑器的
 * 读写都汇到这里)。全局目录(~/.agents、~/.claude)只读不写——那不是
 * 我们的地盘;内置目录随应用发布,用户想改就在这里放一个同名技能覆盖它
 * (扫描器 app 源优先)。
 *
 * ## 路径守卫
 *
 * 渲染进程传来的 name / rel 都当不可信输入:name 不许含路径分隔符,
 * rel 逐段校验后 normalize,结果必须还在技能目录内。守不住这条,
 * 渲染层一个 XSS 就能改写任意文件。
 */

function root(): string {
  return join(DATA_DIR, 'skills')
}

function skillDir(name: string): string {
  const trimmed = name.trim()
  if (!trimmed) throw new Error('技能名不能为空')
  if (/[/\\]/.test(trimmed) || trimmed === '.' || trimmed === '..' || trimmed.startsWith('.')) {
    throw new Error('技能名不能包含路径分隔符,也不能以点开头')
  }
  return join(root(), trimmed)
}

/** rel 解析到技能目录内的绝对路径;任何形式的越界都直接拒绝 */
function resolveEntry(name: string, rel: string): string {
  const dir = skillDir(name)
  if (isAbsolute(rel)) throw new Error('只接受相对路径')
  const target = normalize(join(dir, rel))
  if (target !== dir && !target.startsWith(dir + sep)) {
    throw new Error('路径越出了技能目录')
  }
  return target
}

export function skillTree(name: string): SkillFileNode[] {
  const dir = skillDir(name)
  if (!existsSync(dir)) return []
  return readTree(dir, '')
}

function readTree(abs: string, relBase: string): SkillFileNode[] {
  const entries = readdirSync(abs, { withFileTypes: true })
    .filter((e) => !e.name.startsWith('.'))
    .map((e) => {
      const rel = relBase ? `${relBase}/${e.name}` : e.name
      const node: SkillFileNode = {
        name: e.name,
        path: rel,
        type: e.isDirectory() ? 'dir' : 'file'
      }
      if (node.type === 'dir') node.children = readTree(join(abs, e.name), rel)
      return node
    })
  // 目录在前,同类按名排——和所有文件管理器一致,不给用户惊喜
  return entries.sort((a, b) =>
    a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1
  )
}

const MAX_FILE_BYTES = 1024 * 1024

export function readSkillFile(name: string, rel: string): string {
  const path = resolveEntry(name, rel)
  if (statSync(path).size > MAX_FILE_BYTES) {
    throw new Error('文件超过 1MB,技能文件不该这么大')
  }
  return readFileSync(path, 'utf-8')
}

export function writeSkillFile(name: string, rel: string, content: string): void {
  const path = resolveEntry(name, rel)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content, 'utf-8')
}

export function mkdirSkill(name: string, rel: string): void {
  mkdirSync(resolveEntry(name, rel), { recursive: true })
}

export function removeSkillEntry(name: string, rel: string): void {
  const path = resolveEntry(name, rel)
  // rel 为空会解析成技能根目录——删整个技能走 removeSkillPackage,语义要分开
  if (path === skillDir(name)) throw new Error('不能删除技能根目录,请用删除技能')
  rmSync(path, { recursive: true, force: true })
}

/** 新建技能:目录 + 模板 SKILL.md。已存在就报错,不静默覆盖 */
export function createSkillPackage(name: string): InstalledSkill {
  const dir = skillDir(name)
  if (existsSync(dir)) throw new Error(`技能「${name}」已存在`)
  mkdirSync(dir, { recursive: true })
  const description = '一句话说明这个技能什么时候用(模型靠它判断要不要加载,写具体些)'
  writeFileSync(
    join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\n在这里写技能内容。建议:规则写成可判定的祈使句,配触发场景与反例。\n`,
    'utf-8'
  )
  return { name, description, source: 'app', dir }
}

export function removeSkillPackage(name: string): void {
  const dir = skillDir(name)
  rmSync(dir, { recursive: true, force: true })
}

/** 市场安装:把清单里的内容落成 SKILL.md。身份是名字,同名视为已安装 */
export function installSkillContent(
  name: string,
  description: string,
  content: string
): InstalledSkill {
  const dir = skillDir(name)
  if (existsSync(dir)) throw new Error(`技能「${name}」已安装`)
  mkdirSync(dir, { recursive: true })
  const front = `---\nname: ${name}\ndescription: ${escapeYaml(description)}\n---\n\n`
  const body = content.startsWith('---') ? content : front + content
  writeFileSync(join(dir, 'SKILL.md'), `${body.trimEnd()}\n`, 'utf-8')
  return { name, description, source: 'app', dir }
}

function escapeYaml(value: string): string {
  // description 里带冒号是常态("Use when: …"),整体加引号一了百了
  return JSON.stringify(value)
}
