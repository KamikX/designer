import { promptText } from '../ai/prompts/i18n'
import type { PromptLanguage } from '../ai/prompts/i18n'
import { tool } from 'ai'
import type { ToolSet } from 'ai'
import { z } from 'zod'
import { condenseIfLong } from '../ai/assistant'
import { withPage } from './browser'
import { ssrfProblem } from './ssrf'
import { EXTRACT_ARTICLE, FALLBACK_EXTRACT } from './extract'
import { readVendor } from './vendor'
import { webSearch } from './search'
import { browserSession } from './session'
import type { BrowserSession } from './session'
import type { RenderedPage } from './browser'

/**
 * 联网工具。**默认不注册**——只有用户在输入框上把联网开关点亮,这一轮才有。
 *
 * 这个开关是每轮传的,不是持久设置:用户点亮它是一个"这句话要联网"的即时
 * 决定。做成持久状态的话,会出现"上周开过、今天忘了它还开着"——然后每一句
 * 闲聊都在偷偷发请求。
 */

/**
 * 浏览器操作工具。
 *
 * 接口照 Chrome DevTools MCP 的设计,尤其偷了它两个关键决定:
 *
 * 1. **每个动作都返回新快照**。引用失效(点完页面重渲染、旧编号指向别的东西)
 *    是这类工具的头号故障模式。与其做失效检测,不如把重新快照折进动作结果里
 *    ——模型看到的永远是当下,而且省掉一半来回。
 * 2. **fill_form 批量填**。一个字段一次调用的话,一个登录表单要三轮,而中间
 *    每一轮页面都可能变。
 */
function browserTools(streamId: string, lang: PromptLanguage = 'zh-CN'): ToolSet {
  const session = (): BrowserSession => browserSession(streamId)

  /** 动作 → 新快照。所有动作共用这一条出口,保证行为一致 */
  const then = async (label: string, action: () => Promise<void>): Promise<string> => {
    try {
      await action()
    } catch (err) {
      return `错误:${label}失败——${err instanceof Error ? err.message : String(err)}`
    }
    const snapshot = await session().snapshot()
    return `${label}完成。\n\n${snapshot.text}`
  }

  return {
    browser_open: tool({
      description: promptText(lang, 'tools.browser_open.description'),
      inputSchema: z.object({
        url: z.string().describe(promptText(lang, 'tools.browser_open.parameters.url'))
      }),
      execute: async (input) => {
        if (!/^https?:\/\//i.test(input.url)) return `错误:只支持 http/https,收到「${input.url}」。`
        try {
          const snapshot = await session().open(input.url)
          return snapshot.text
        } catch (err) {
          return `错误:打不开 ${input.url}(${err instanceof Error ? err.message : String(err)})`
        }
      }
    }),

    browser_snapshot: tool({
      description: promptText(lang, 'tools.browser_snapshot.description'),
      inputSchema: z.object({}),
      execute: async () => {
        try {
          return (await session().snapshot()).text
        } catch (err) {
          return `错误:${err instanceof Error ? err.message : String(err)}`
        }
      }
    }),

    browser_click: tool({
      description: promptText(lang, 'tools.browser_click.description'),
      inputSchema: z.object({
        uid: z.string().describe(promptText(lang, 'tools.browser_click.parameters.uid')),
        why: z.string().optional().describe(promptText(lang, 'tools.browser_click.parameters.why'))
      }),
      execute: async (input) => then(`点击 ${input.uid}`, () => session().click(input.uid))
    }),

    browser_fill_form: tool({
      description: promptText(lang, 'tools.browser_fill_form.description'),
      inputSchema: z.object({
        fields: z
          .array(
            z.object({
              uid: z.string().describe(promptText(lang, 'tools.browser_fill_form.parameters.uid')),
              value: z
                .string()
                .describe(promptText(lang, 'tools.browser_fill_form.parameters.value'))
            })
          )
          .describe(promptText(lang, 'tools.browser_fill_form.parameters.fields'))
      }),
      execute: async (input) =>
        then(`填写 ${input.fields.length} 个字段`, async () => {
          for (const field of input.fields) await session().fill(field.uid, field.value)
        })
    }),

    browser_press_key: tool({
      description: promptText(lang, 'tools.browser_press_key.description'),
      inputSchema: z.object({
        key: z.enum(['Enter', 'Tab', 'Escape', 'ArrowDown', 'ArrowUp', 'Backspace'])
      }),
      execute: async (input) => then(`按下 ${input.key}`, () => session().press(input.key))
    }),

    browser_scroll: tool({
      description: promptText(lang, 'tools.browser_scroll.description'),
      inputSchema: z.object({
        direction: z
          .enum(['down', 'up'])
          .describe(promptText(lang, 'tools.browser_scroll.parameters.direction'))
      }),
      execute: async (input) =>
        then(`向${input.direction === 'down' ? '下' : '上'}滚动`, () =>
          session().scroll(input.direction === 'down' ? 600 : -600)
        )
    })
  }
}

export function buildWebTools(
  enabled: boolean,
  streamId?: string,
  lang: PromptLanguage = 'zh-CN'
): ToolSet {
  if (!enabled) return {}

  const tools = {
    // 有 streamId 才给浏览器操作:那些工具要按轮次持有一个常驻窗口,
    // 没有归属就没法在轮次结束时回收
    ...(streamId ? browserTools(streamId, lang) : {}),
    web_search: tool({
      description: promptText(lang, 'tools.web_search.description'),
      inputSchema: z.object({
        query: z.string().describe(promptText(lang, 'tools.web_search.parameters.query'))
      }),
      execute: async (input) => {
        const outcome = await webSearch(input.query)

        if (outcome.blocked) {
          // 说清楚是"被拦了"而不是"没搜到"——这两件事模型该做的反应完全不同
          return (
            '错误:搜索被目标站点的反爬机制拦截,本次没有拿到任何结果。' +
            '这不等于"搜不到"。请告诉用户可以到设置里配置搜索 API(Brave / Tavily)作为备用来源,' +
            '在那之前不要凭记忆回答需要联网的问题。'
          )
        }
        if (outcome.hits.length === 0) return `没有搜到与「${input.query}」相关的结果。`

        const list = outcome.hits
          .map((h, i) => `${i + 1}. ${h.title}\n   ${h.url}\n   ${h.snippet}`)
          .join('\n\n')
        return `${outcome.hits.length} 条结果(来源:${outcome.via === 'api' ? '搜索 API' : '浏览器'})\n\n${list}`
      }
    }),

    web_fetch: tool({
      description: promptText(lang, 'tools.web_fetch.description'),
      inputSchema: z.object({
        url: z.string().describe(promptText(lang, 'tools.web_fetch.parameters.url')),
        intent: z
          .string()
          .optional()
          .describe(promptText(lang, 'tools.web_fetch.parameters.intent'))
      }),
      execute: async (input) => {
        if (!/^https?:\/\//i.test(input.url)) {
          return `错误:只支持 http/https 链接,收到的是「${input.url}」。`
        }
        // URL 来自模型,而模型读过的网页可能带提示注入。内网与元数据端点一律拒
        const blocked = await ssrfProblem(input.url)
        if (blocked) return `错误:${blocked}。`
        try {
          const page = await withPage<RenderedPage>(input.url, EXTRACT_ARTICLE, {
            inject: [readVendor('defuddle.js'), FALLBACK_EXTRACT]
          })
          if (!page.text.trim()) {
            return `打开了 ${page.url},但没有提取到正文。可能是纯图片页、需要登录,或内容在 iframe 里。`
          }
          /*
           * 反爬墙和死链必须区分(cloud-mcp-go 验证过的经验):把验证码页
           * 当成"打开了但没内容",模型会误判成死链而放弃或反复重试。
           * 说清"这不是死链",它才知道该换信息源。
           */
          if (looksLikeAntiBot(page.text)) {
            return (
              `${page.url} 返回的是人机验证/反爬拦截页,不是死链。` +
              `这个站点拿不到正文,换一个信息源(比如搜索结果里的其他链接)。`
            )
          }
          /*
           * 正文大小上限:提取脚本可能在超长页面(巨型文档单页、日志页)上
           * 返回几 MB 文本,先截断再交给辅助模型压缩,别让一个页面吃掉整个
           * 上下文预算。截断点选在段落边界,尾部加说明。
           */
          const capped = capText(page.text, 200_000)
          // 长文交给辅助模型压缩,而不是硬截断——截断会把结论切掉,
          // 而结论往往在文章末尾。没配辅助模型时它原样返回,不会失败
          const condensed = await condenseIfLong(capped, input.intent)
          const meta = [
            `来源:${page.url}`,
            page.author ? `作者:${page.author}` : '',
            page.published ? `时间:${page.published}` : '',
            condensed.note
          ]
            .filter(Boolean)
            .join('\n')
          return `# ${page.title}\n${meta}\n\n${condensed.text}`
        } catch (err) {
          return `错误:打不开 ${input.url}(${err instanceof Error ? err.message : String(err)})`
        }
      }
    })
  }

  return tools
}

/** 只扫开头一段——验证码页都很短,长正文不可能是拦截页,别白扫几百 KB */
function looksLikeAntiBot(text: string): boolean {
  const head = text.slice(0, 4000).toLowerCase()
  return (
    text.length < 4000 &&
    /captcha|just a moment|attention required|verify you are human|unusual traffic|安全验证|人机验证|访问验证|滑动验证|请完成验证/.test(
      head
    )
  )
}

/** 按段落边界截断,尾部注明截了多少 */
function capText(text: string, max: number): string {
  if (text.length <= max) return text
  const cut = text.lastIndexOf('\n', max)
  const kept = text.slice(0, cut > max / 2 ? cut : max)
  return `${kept}\n\n(正文过长,已截断:保留 ${kept.length} / 共 ${text.length} 字符)`
}
