import { localizedTools } from '../i18n'
import { text as appText, aiText } from '../i18n'
import { promptText } from '../ai/prompts/i18n'
import type { PromptLanguage } from '../ai/prompts/i18n'
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

export function buildInstallTools(
  context: InstallToolContext,
  lang: PromptLanguage = 'zh-CN'
): ToolSet {
  const tools = {
    install_skill: tool({
      description: promptText(lang, 'tools.install_skill.description'),
      inputSchema: z.object({
        content: z.string().describe(promptText(lang, 'tools.install_skill.parameters.content')),
        summary: z.string().describe(promptText(lang, 'tools.install_skill.parameters.summary'))
      }),
      execute: async (input) => {
        const answer = await context.ask({
          intro: promptText(lang, 'install.skill.intro', { summary: input.summary }),
          questions: [
            {
              header: promptText(lang, 'install.skill.header'),
              question: promptText(lang, 'install.skill.question'),
              kind: 'single',
              options: [
                {
                  label: promptText(lang, 'install.skill.global'),
                  description: promptText(lang, 'install.skill.globalDescription')
                },
                {
                  label: promptText(lang, 'install.skill.app'),
                  description: promptText(lang, 'install.skill.appDescription')
                }
              ]
            }
          ]
        })

        if (answer.skipped) return appText('messages.theUserCanceledInstallation')
        const picked = answer.selections[0]?.[0] ?? ''
        const scope = picked.startsWith(
          promptText(lang, 'install.skill.global').split('(')[0].trim()
        )
          ? 'global'
          : 'app'

        const result = installSkill(input.content, scope)
        if (!result.ok) return aiText('ai.imageTools.error', result.error)

        context.onChanged()
        return appText(
          'messages.installedToItWillAppearInAvailableSkillsFromTheNextTurn',
          result.dir
        )
      }
    }),

    install_mcp: tool({
      description: promptText(lang, 'tools.install_mcp.description'),
      inputSchema: z.object({
        name: z.string().describe(promptText(lang, 'tools.install_mcp.parameters.name')),
        summary: z.string().describe(promptText(lang, 'tools.install_mcp.parameters.summary')),
        command: z
          .string()
          .optional()
          .describe(promptText(lang, 'tools.install_mcp.parameters.command')),
        args: z
          .array(z.string())
          .optional()
          .describe(promptText(lang, 'tools.install_mcp.parameters.args')),
        url: z.string().optional().describe(promptText(lang, 'tools.install_mcp.parameters.url')),
        secrets: z
          .array(z.object({ key: z.string(), label: z.string(), help: z.string().optional() }))
          .optional()
          .describe(promptText(lang, 'tools.install_mcp.parameters.secrets'))
      }),
      execute: async (input) => {
        if (!input.command && !input.url) {
          return appText('messages.errorStdioRequiresACommandHttpSseRequiresAUrlOneMustBeSpecified')
        }

        const shown = input.url ?? [input.command, ...(input.args ?? [])].join(' ')
        const answer = await context.ask({
          intro:
            promptText(lang, 'install.mcp.intro', { name: input.name, summary: input.summary }) +
            (input.url
              ? promptText(lang, 'install.mcp.connect', { target: shown })
              : promptText(lang, 'install.mcp.execute', { target: shown })),
          questions: [
            {
              header: promptText(lang, 'install.mcp.header'),
              question: promptText(lang, 'install.mcp.question'),
              kind: 'single',
              options: [
                { label: promptText(lang, 'install.mcp.confirm') },
                {
                  label: promptText(lang, 'install.mcp.cancel'),
                  description: promptText(lang, 'install.mcp.cancelDescription')
                }
              ]
            }
          ],
          // 密钥和确认放在同一张卡片里:分两次问的话用户要点两轮,
          // 而且第二轮弹出来时他已经忘了上下文
          ...(input.secrets?.length ? { secrets: input.secrets } : {})
        })

        if (
          answer.skipped ||
          answer.selections[0]?.[0] === promptText(lang, 'install.mcp.cancel')
        ) {
          return appText('messages.theUserCanceledInstallationNoChangesWereMade')
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
            appText('messages.configurationSavedButTheConnectionTestFailed', probe.error) +
            appText(
              'messages.theConfigurationRemainsInMcpJsonServiceNameAndCanBeCorrectedManually',
              input.name
            ) +
            appText('messages.reportThisErrorAccuratelyToTheUserDoNotClaimInstallationSucceeded')
          )
        }
        return appText(
          'messages.installedSuccessfullyProvidesTools',
          input.name,
          probe.tools?.length ?? 0,
          (probe.tools ?? []).join('、')
        )
      }
    })
  }
  return localizedTools(tools, lang)
}
