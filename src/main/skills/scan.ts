import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { parse as parseYaml } from 'yaml'
import electron from 'electron'
import { DATA_DIR } from '../paths'
import type { WorkspaceRoot } from '../../shared/types'

/**
 * 从文件系统扫描技能(Agent Skills 格式)。
 *
 * ## 为什么是文件而不是数据库
 *
 * `~/.agents/skills` 是**跨工具的共享位置**——Claude Code、Codex、Cursor 等都读
 * 它(规范见 agentskills.io)。这台机器上就有 35 个现成技能,还有一个指向
 * `~/.codex/` 的符号链接。把技能锁在我们自己的 SQLite 里,等于让用户为同一份
 * 知识维护两遍。
 *
 * ## 只取 frontmatter
 *
 * 这里**不读正文**。正文由 activate_skill 按需取(见 catalog.ts 里对渐进披露的
 * 说明)。实测这台机器上 35 个技能的 SKILL.md 正文合计 16 万字符,全量注入是
 * 不可能的。
 */

/**
 * builtin 与 builtin-* 各领域分开:builtin(craft/target/design-seed)在
 * 设计会话里自动生效,而 builtin-pm/fullstack/ui/agent(随应用发布的领域
 * 技能包)只服务协作群组——混在一个源里,设计会话的技能目录会被上百个
 * 领域技能灌满;分开的源也让成员编辑器能按领域分组展示。
 */
export type SkillSource =
  | 'app'
  | 'agents'
  | 'claude'
  | 'builtin'
  | 'builtin-pm'
  | 'builtin-fullstack'
  | 'builtin-ui'
  | 'builtin-agent'

export interface FileSkill {
  name: string
  description: string
  /** SKILL.md 的绝对路径。模型据此解析正文里的 references/xxx */
  path: string
  /** 技能根目录 */
  dir: string
  source: SkillSource
  /**
   * 用户在更高优先级目录放了同名技能,盖掉了内置版。
   * 设计会话里"内置自动可用"要认这份覆盖版,不能因为它 source 变了就要求勾选。
   */
  coversBuiltin?: boolean
  /** 不影响加载但值得在界面上标出来的问题 */
  warning?: string
}

/**
 * 扫描顺序即优先级,靠前的覆盖靠后的同名项。
 *
 * app 排最前:用户想为这个应用定制某个技能时,不必去改跨工具共享的那份。
 */
function sources(): { source: SkillSource; root: string }[] {
  const home = homedir()
  return [
    { source: 'app', root: join(DATA_DIR, 'skills') },
    // 跨工具约定,规范推荐的位置
    { source: 'agents', root: join(home, '.agents', 'skills') },
    // 兼容:大量现存技能装在这里
    { source: 'claude', root: join(home, '.claude', 'skills') },
    // 随应用发布的手艺规则与设计种子。**排最后**:用户想覆盖同名的那份时,
    // 放到前面任何一个目录里就行,不用改我们的代码
    { source: 'builtin', root: builtinRoot() },
    // 随应用发布的领域技能包(项目管理/全栈/UI/工程方法)。同样可被用户目录覆盖
    { source: 'builtin-pm', root: resourcesDir('skills-pm') },
    { source: 'builtin-fullstack', root: resourcesDir('skills-fullstack') },
    { source: 'builtin-ui', root: resourcesDir('skills-ui') },
    { source: 'builtin-agent', root: resourcesDir('skills-agent') }
  ]
}

/**
 * 内置技能目录。
 *
 * 打包后 resources 会被解包到 asar 之外(见 electron-builder.yml 的 asarUnpack),
 * 所以直接按路径读即可。开发时就是仓库里的 resources/skills。
 *
 * 拿不到 app 时退回 cwd:electron.app.getAppPath() 在 ready 之前不可用,单测里更是根本
 * 没有 electron。扫描技能这件事不该因为宿主环境不齐就整个失败——退回去的路径
 * 存不存在由 scanRoot 自己判断。
 */
function builtinRoot(): string {
  return resourcesDir('skills')
}

function resourcesDir(name: string): string {
  try {
    return join(electron.app.getAppPath(), 'resources', name)
  } catch {
    return join(process.cwd(), 'resources', name)
  }
}

export function scanSkills(): FileSkill[] {
  const found = new Map<string, FileSkill>()
  // 符号链接可能指回已扫过的目录(比如 .claude/skills 和 .agents/skills 互指),
  // 按 realpath 去重,顺带防成环
  const visited = new Set<string>()

  for (const { source, root } of sources()) {
    for (const skill of scanRoot(root, source, visited)) {
      // 先到先得 = 前面的源优先
      if (!found.has(skill.name)) found.set(skill.name, skill)
      // builtin 排最后:走到这里说明有更高优先级的同名技能盖掉了内置版
      else if (source === 'builtin') found.get(skill.name)!.coversBuiltin = true
    }
  }
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name))
}

function scanRoot(root: string, source: SkillSource, visited: Set<string>): FileSkill[] {
  if (!existsSync(root)) return []

  const out: FileSkill[] = []
  for (const entry of listDirs(root)) {
    const direct = readSkill(entry.path, entry.name, source, visited)
    if (direct) {
      out.push(direct)
      continue
    }

    /*
     * 没有 SKILL.md 的目录,再往下看一层。
     *
     * 这不是臆测的形态:`~/.agents/skills/superpowers` 是个指向
     * `~/.codex/superpowers/skills` 的符号链接,里面装着 14 个技能。技能集合
     * 打包分发时就长这样,只扫一层会把它们整批漏掉。
     *
     * 只下探一层——再深就分不清"技能集合"和"技能自带的 references 目录"了。
     */
    for (const nested of listDirs(entry.path)) {
      const skill = readSkill(nested.path, nested.name, source, visited)
      if (skill) out.push(skill)
    }
  }
  return out
}

function listDirs(root: string): { name: string; path: string }[] {
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((e) => !e.name.startsWith('.'))
      .map((e) => ({ name: e.name, path: join(root, e.name) }))
      .filter((e) => {
        try {
          // statSync 跟随符号链接;isDirectory() 对链接本身是 false
          return statSync(e.path).isDirectory()
        } catch {
          return false
        }
      })
  } catch {
    return []
  }
}

function readSkill(
  dir: string,
  dirName: string,
  source: SkillSource,
  visited: Set<string>
): FileSkill | null {
  const path = join(dir, 'SKILL.md')
  if (!existsSync(path)) return null

  let real: string
  try {
    real = realpathSync(dir)
  } catch {
    return null
  }
  if (visited.has(real)) return null
  visited.add(real)

  let raw: string
  try {
    raw = readFileSync(path, 'utf-8')
  } catch {
    return null
  }

  const front = frontmatter(raw)
  if (!front) return null

  const name = typeof front.name === 'string' ? front.name.trim() : ''
  const description = typeof front.description === 'string' ? front.description.trim() : ''
  // description 是模型判断"该不该加载"的唯一依据,缺了这条技能就是不可用的
  if (!description) return null

  const warnings: string[] = []
  if (!name) warnings.push('缺少 name,用目录名代替')
  else if (name !== dirName) warnings.push(`name(${name})与目录名(${dirName})不一致`)

  return {
    // 规范要求 name 与目录名一致。不一致时**以目录名为准**——激活时是按名字
    // 找目录的,信 frontmatter 会找不到
    name: dirName,
    description,
    path,
    dir,
    source,
    ...(warnings.length ? { warning: warnings.join(';') } : {})
  }
}

/**
 * 解析 frontmatter。
 *
 * 用真正的 YAML 解析器而不是手写:实测这台机器上的技能里出现了块标量(`>`)、
 * 引号值、缩进续行和嵌套 map——手写等于重新实现 YAML,而在真实文件上出错的
 * 代价比一个依赖高得多。
 *
 * 失败时补救一次再放弃:`description: Use when: foo` 这种没给冒号加引号的写法
 * 在野外很常见,而它不是合法 YAML。规范的实现指南也明确要求处理这一种。
 */
function frontmatter(raw: string): Record<string, unknown> | null {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw)
  if (!match) return null

  const body = match[1]
  const parsed = tryYaml(body)
  if (parsed) return parsed

  // 给 description 的值整体加引号再试一次
  const repaired = body.replace(
    /^(description:)\s*(.*:.*)$/m,
    (_, key: string, value: string) => `${key} ${JSON.stringify(value.trim())}`
  )
  return repaired === body ? null : tryYaml(repaired)
}

function tryYaml(text: string): Record<string, unknown> | null {
  try {
    const value = parseYaml(text) as unknown
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/**
 * 把技能目录包装成只读的授权范围。
 *
 * 技能正文里会写"详见 references/xxx.md",而 read_local_file 只认授权过的路径。
 * 不加这个,模型激活了技能却读不了它引用的文档——渐进披露的第三层断在这里,
 * 而且报错信息是"路径不在授权范围内",看着像用户配错了。
 *
 * id 用 `skill:` 前缀标记来源,和用户真正授权的目录区分开;它们不进数据库,
 * 只在这一轮的工具里生效。
 */
export function skillRoots(skills: FileSkill[]): WorkspaceRoot[] {
  return skills.map((s) => ({ id: `skill:${s.name}`, path: s.dir, name: s.name }))
}
