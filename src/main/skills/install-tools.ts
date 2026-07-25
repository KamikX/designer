import { tool } from 'ai'
import type { ToolSet } from 'ai'
import { z } from 'zod'
import { upsertMcpServer } from '../mcp/config'
import { probeMcpServer } from '../mcp/probe'
import { allSecrets } from '../mcp/secrets'
import { installSkill } from './install'
import type { AskUserAnswer, AskUserInput } from '../../shared/types'

/**
 * 让 AI 自己装技能和 MCP 的工具。
 *
 * ## 一条硬规则:装什么、装到哪,都由用户拍板
 *
 * 这两个动作都在**改用户机器上的持久状态**,而且 `~/.agents/skills` 是跨工具
 * 共享的、MCP 是要起进程的。所以两个工具都强制走 ask_user,模型不能自己决定。
 *
 * 这不是给模型加限制,是给用户留出否决的机会——他看到完整命令之后可能会说
 * "算了"。没有这一步的话,"帮我装个 X" 就变成了一句无法撤回的话。
 */

export interface InstallToolContext {
  /** 复用 ask_user 的通道:同一套卡片 UI,同一套阻塞语义 */
  ask: (input: AskUserInput) => Promise<AskUserAnswer>
  /** 装完通知外层重扫,下一轮目录里就有了 */
  onChanged: () => void
}

export function buildInstallTools(context: InstallToolContext): ToolSet {
  const tools = {
    install_skill: tool({
      description:
        '安装一个技能。content 必须是完整的 SKILL.md(含 --- 包起来的 frontmatter,' +
        '其中 name 和 description 必填,description 要写清"是什么 + 什么时候用")。' +
        '**会先问用户装到哪里**,不要自己假设。',
      inputSchema: z.object({
        content: z.string().describe('完整的 SKILL.md 文本'),
        summary: z.string().describe('一句话说明这个技能是干什么的,给用户看')
      }),
      execute: async (input) => {
        const answer = await context.ask({
          intro: `要安装技能:${input.summary}`,
          questions: [
            {
              header: '装到哪',
              question: '这个技能装到哪个位置?',
              kind: 'single',
              options: [
                {
                  label: '全局(~/.agents/skills)',
                  description: '其他 AI 工具(Claude Code、Codex 等)也能用到'
                },
                {
                  label: '仅本应用',
                  description: '只在这个应用里生效,不影响你在别处的配置'
                }
              ]
            }
          ]
        })

        if (answer.skipped) return '用户取消了安装。'
        const picked = answer.selections[0]?.[0] ?? ''
        const scope = picked.startsWith('全局') ? 'global' : 'app'

        const result = installSkill(input.content, scope)
        if (!result.ok) return `错误:${result.error}`

        context.onChanged()
        return `已安装到 ${result.dir}。下一轮对话就能在 available_skills 里看到它。`
      }
    }),

    install_mcp: tool({
      description:
        '安装一个 MCP 服务。**会先把完整命令给用户确认**,需要密钥时会逐个问。' +
        '装完自动连一次做验证,并告诉你它提供了哪些工具。',
      inputSchema: z.object({
        name: z.string().describe('服务名,用作配置里的键'),
        summary: z.string().describe('一句话说明它是干什么的'),
        command: z.string().optional().describe('stdio 类的可执行命令,如 npx'),
        args: z.array(z.string()).optional().describe('命令参数'),
        url: z.string().optional().describe('http/sse 类的服务地址'),
        secrets: z
          .array(z.object({ key: z.string(), label: z.string(), help: z.string().optional() }))
          .optional()
          .describe('需要用户提供的密钥。配置里用 ${KEY} 引用,真值加密存储')
      }),
      execute: async (input) => {
        if (!input.command && !input.url) {
          return '错误:stdio 类要给 command,http/sse 类要给 url,二者必居其一。'
        }

        const shown = input.url ?? [input.command, ...(input.args ?? [])].join(' ')
        const answer = await context.ask({
          intro:
            `要安装 MCP 服务「${input.name}」:${input.summary}\n\n` +
            (input.url
              ? `它会连接:${shown}`
              : `它会在你的机器上执行:\n${shown}\n\n进程以你的身份运行,能做的事和你在终端里一样。`),
          questions: [
            {
              header: '确认',
              question: '确认安装吗?',
              kind: 'single',
              options: [{ label: '安装' }, { label: '取消', description: '不做任何改动' }]
            }
          ],
          // 密钥和确认放在同一张卡片里:分两次问的话用户要点两轮,
          // 而且第二轮弹出来时他已经忘了上下文
          ...(input.secrets?.length ? { secrets: input.secrets } : {})
        })

        if (answer.skipped || answer.selections[0]?.[0] === '取消') {
          return '用户取消了安装,没有做任何改动。'
        }

        // 配置里只写占位符,真值在加密存储里
        const env = Object.fromEntries((input.secrets ?? []).map((s) => [s.key, `\${${s.key}}`]))
        const config = {
          ...(input.command ? { command: input.command, args: input.args ?? [] } : {}),
          ...(input.url ? { type: 'http' as const, url: input.url } : {}),
          ...(Object.keys(env).length ? { env } : {})
        }

        upsertMcpServer(input.name, config)
        context.onChanged()

        const probe = await probeMcpServer(input.name, config, allSecrets())
        if (!probe.ok) {
          // **保留配置**:让用户能自己去 mcp.json 里改,而不是从头再来一遍
          return (
            `已写入配置,但连接测试失败:${probe.error}\n\n` +
            `配置保留在 mcp.json 里(服务名:${input.name}),用户可以自己修正。` +
            `请把这个错误如实告诉用户,不要声称安装成功。`
          )
        }
        return `安装成功。${input.name} 提供了 ${probe.tools?.length ?? 0} 个工具:${(probe.tools ?? []).join('、')}`
      }
    })
  }
  return tools
}
