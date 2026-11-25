import { localizedTools } from '../i18n'
import { text as appText } from '../i18n'
import { promptText } from '../ai/prompts/i18n'
import type { PromptLanguage } from '../ai/prompts/i18n'
import { existsSync, readFileSync, readdirSync } from 'fs'
import { join, relative } from 'path'
import { tool } from 'ai'
import type { ToolSet } from 'ai'
import { z } from 'zod'
import type { FileSkill } from './scan'

/**
 * 技能激活工具(渐进披露的 L2)。
 *
 * ## 为什么是专用工具而不是让模型自己读文件
 *
 * 规范里两种实现都允许。选专用工具的唯一理由是 **name 可以约束成 enum**:
 * 模型没法激活一个不存在的技能。让它自己拼路径去读的话,拼错了只会得到一个
 * "文件不存在",然后它多半会再猜一个路径。
 *
 * 没有任何技能时**整个工具不注册**——注册一个空 enum 的工具,只会让模型盯着它
 * 想办法用。
 */

/** 正文上限。规范建议单个技能正文控制在 5000 token 以内,这里按字符给个硬顶 */
const MAX_BODY = 20_000

export function buildSkillTools(skills: FileSkill[], lang: PromptLanguage = 'zh-CN'): ToolSet {
  if (skills.length === 0) return localizedTools({}, lang)

  const byName = new Map(skills.map((s) => [s.name, s]))
  const names = skills.map((s) => s.name) as [string, ...string[]]

  const tools = {
    activate_skill: tool({
      description: promptText(lang, 'tools.activate_skill.description'),
      inputSchema: z.object({
        // enum 是这个工具存在的理由:从结构上杜绝模型编出一个不存在的技能名
        name: z.enum(names).describe(promptText(lang, 'tools.activate_skill.parameters.name'))
      }),
      execute: async (input) => {
        const skill = byName.get(input.name)
        if (!skill) return appText('messages.errorNoSkillNamed', input.name)

        let raw: string
        try {
          raw = readFileSync(skill.path, 'utf-8')
        } catch (err) {
          return appText(
            'messages.errorCannotRead',
            skill.path,
            err instanceof Error ? err.message : err
          )
        }

        // frontmatter 已经在目录里给过了,再给一遍是重复占位
        const body = stripFrontmatter(raw).slice(0, MAX_BODY)
        const resources = listResources(skill.dir)

        return [
          `<skill_content name="${skill.name}">`,
          body.trim(),
          '',
          appText('common.skillDirectory', skill.dir),
          resources.length
            ? `<skill_resources>\n${resources.map((f) => `  <file>${f}</file>`).join('\n')}\n</skill_resources>`
            : '',
          '</skill_content>'
        ]
          .filter(Boolean)
          .join('\n')
      }
    })
  }
  return localizedTools(tools, lang)
}

function stripFrontmatter(raw: string): string {
  return raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '')
}

/**
 * 列出技能自带的资源文件。
 *
 * 正文里常写"详见 references/xxx.md",但模型不知道那里究竟有哪些文件——列出来
 * 它才能直接读对的那个,而不是先 list_local_dir 试探一轮。
 *
 * 只列两层。再深的目录(比如 antdv-next 的 references/components 下几百个文件)
 * 列出来只会淹没正文。
 */
function listResources(dir: string): string[] {
  const out: string[] = []
  for (const sub of ['references', 'scripts', 'assets']) {
    const root = join(dir, sub)
    if (!existsSync(root)) continue
    try {
      for (const entry of readdirSync(root, { withFileTypes: true })) {
        if (entry.isFile()) out.push(relative(dir, join(root, entry.name)))
        else if (entry.isDirectory()) out.push(`${relative(dir, join(root, entry.name))}/…`)
        if (out.length >= 40) return out
      }
    } catch {
      // 读不了就当没有,不该因此让整次激活失败
    }
  }
  return out
}
