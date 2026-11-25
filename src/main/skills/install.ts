import { text as appText } from '../i18n'
import { mkdirSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { parse as parseYaml } from 'yaml'
import { DATA_DIR } from '../paths'

/**
 * 安装技能:把 SKILL.md 写进目标目录。
 *
 * ## 装到哪由用户决定
 *
 * `~/.agents/skills` 是**跨工具共享**的——Claude Code、Codex、Cursor 都读它。
 * 往里写东西会影响用户在别处的使用,这个决定不该由模型代做。所以安装工具必须
 * 先 ask_user 问清楚,再调这里。
 *
 * ## 内容是不可信输入
 *
 * 用户会让 AI 从 GitHub 装第三方技能,而技能内容最终会进模型的上下文。这里只
 * 做**格式**校验,不做内容判断——真正的防线是渐进披露本身:目录里只放
 * description,正文是工具返回值(数据)而不是系统提示(指令)。
 */

export type InstallScope = 'global' | 'app'

export interface InstallResult {
  ok: boolean
  /** 写到哪了 */
  dir?: string
  error?: string
}

export function skillRoot(scope: InstallScope): string {
  return scope === 'global' ? join(homedir(), '.agents', 'skills') : join(DATA_DIR, 'skills')
}

/**
 * @param content 完整的 SKILL.md 文本(含 frontmatter)
 */
export function installSkill(content: string, scope: InstallScope): InstallResult {
  const front = parseFrontmatter(content)
  if (!front) {
    return {
      ok: false,
      error: appText('messages.skillMdHasNoFrontmatterItMustStartWithAYamlBlockDelimitedBy')
    }
  }

  const name = typeof front.name === 'string' ? front.name.trim() : ''
  const description = typeof front.description === 'string' ? front.description.trim() : ''

  if (!name) return { ok: false, error: appText('messages.frontmatterIsMissingName') }
  if (!description) {
    // 缺了它这个技能永远不会被激活——目录里没有触发条件,模型无从判断
    return { ok: false, error: appText('messages.frontmatterIsMissingDescriptionNeededFor') }
  }

  const invalid = validateName(name)
  if (invalid) return { ok: false, error: invalid }

  const dir = join(skillRoot(scope), name)
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'SKILL.md'), content.endsWith('\n') ? content : `${content}\n`, 'utf-8')
  } catch (err) {
    return {
      ok: false,
      error: appText('common.writeFailed', err instanceof Error ? err.message : err)
    }
  }
  return { ok: true, dir }
}

/**
 * 规范对 name 的约束。校验而不是自动改名:改了之后目录名和 frontmatter 又对不上,
 * 反而制造出扫描时的那种警告。
 */
function validateName(name: string): string | null {
  if (name.length > 64) return appText('messages.nameExceeds64Characters', name)
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name)) {
    return appText('messages.nameMayContainOnlyLowercaseLetters', name)
  }
  return null
}

function parseFrontmatter(raw: string): Record<string, unknown> | null {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw)
  if (!match) return null
  try {
    const value = parseYaml(match[1]) as unknown
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : null
  } catch {
    return null
  }
}
