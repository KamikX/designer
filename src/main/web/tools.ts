import { tool } from 'ai'
import type { ToolSet } from 'ai'
import { z } from 'zod'
import { condenseIfLong } from '../ai/assistant'
import { withPage } from './browser'
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
function browserTools(streamId: string): ToolSet {
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
      description:
        '在受控浏览器里打开一个网页,返回页面的可交互元素快照。' +
        '之后用 browser_click / browser_fill_form 操作,每个动作都会带回新快照。',
      inputSchema: z.object({ url: z.string().describe('完整 URL,http:// 或 https:// 开头') }),
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
      description:
        '重新获取当前页面的元素快照。动作本身已经带回快照,一般不用单独调——' +
        '只在等待异步内容加载完之后需要再看一眼时用。',
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
      description:
        '点击快照里的一个元素。uid 用快照中方括号里的编号(如 e12)。' +
        '**不可逆的操作(提交订单、删除、支付)在点之前必须先用 ask_user 跟用户确认。**',
      inputSchema: z.object({
        uid: z.string().describe('快照里的元素编号,形如 e12'),
        why: z.string().optional().describe('点它是为了什么,一句话')
      }),
      execute: async (input) => then(`点击 ${input.uid}`, () => session().click(input.uid))
    }),

    browser_fill_form: tool({
      description:
        '批量填写表单字段。**优先用它而不是多次单字段填写**:一次调用填完整个表单,' +
        '更快、更稳,也避免中途页面变化导致后面的编号失效。',
      inputSchema: z.object({
        fields: z
          .array(
            z.object({
              uid: z.string().describe('快照里的元素编号'),
              value: z.string().describe('要填入的值,会覆盖原内容')
            })
          )
          .describe('要填的字段,按页面上的先后顺序')
      }),
      execute: async (input) =>
        then(`填写 ${input.fields.length} 个字段`, async () => {
          for (const field of input.fields) await session().fill(field.uid, field.value)
        })
    }),

    browser_press_key: tool({
      description: '按一个键。常用于提交(Enter)、关闭弹层(Escape)、在下拉里移动。',
      inputSchema: z.object({
        key: z.enum(['Enter', 'Tab', 'Escape', 'ArrowDown', 'ArrowUp', 'Backspace'])
      }),
      execute: async (input) => then(`按下 ${input.key}`, () => session().press(input.key))
    }),

    browser_scroll: tool({
      description: '滚动页面。快照里没找到目标元素时先滚一屏再看——很多内容是滚动到才渲染的。',
      inputSchema: z.object({
        direction: z.enum(['down', 'up']).describe('方向')
      }),
      execute: async (input) =>
        then(`向${input.direction === 'down' ? '下' : '上'}滚动`, () =>
          session().scroll(input.direction === 'down' ? 600 : -600)
        )
    })
  }
}

export function buildWebTools(enabled: boolean, streamId?: string): ToolSet {
  if (!enabled) return {}

  const tools = {
    // 有 streamId 才给浏览器操作:那些工具要按轮次持有一个常驻窗口,
    // 没有归属就没法在轮次结束时回收
    ...(streamId ? browserTools(streamId) : {}),
    web_search: tool({
      description:
        '联网搜索,返回标题 / 链接 / 摘要。**先搜再读**:摘要够回答就不要再 web_fetch,' +
        '抓取页面要真的渲染一遍,比搜索贵得多。涉及时效性的问题(版本、价格、新闻)一律先搜。',
      inputSchema: z.object({
        query: z.string().describe('搜索词。像人一样写,不要堆关键词')
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
      description:
        '打开一个网页并取回正文(会真实渲染,JS 生成的内容也拿得到)。' +
        '只在搜索摘要不足以回答时才用,一次一个 URL。',
      inputSchema: z.object({
        url: z.string().describe('完整 URL,必须以 http:// 或 https:// 开头'),
        intent: z.string().optional().describe('你想从这个页面得到什么。正文过长时按它提炼')
      }),
      execute: async (input) => {
        if (!/^https?:\/\//i.test(input.url)) {
          return `错误:只支持 http/https 链接,收到的是「${input.url}」。`
        }
        try {
          const page = await withPage<RenderedPage>(input.url, EXTRACT_ARTICLE, {
            inject: [readVendor('defuddle.js'), FALLBACK_EXTRACT]
          })
          if (!page.text.trim()) {
            return `打开了 ${page.url},但没有提取到正文。可能是纯图片页、需要登录,或内容在 iframe 里。`
          }
          // 长文交给辅助模型压缩,而不是硬截断——截断会把结论切掉,
          // 而结论往往在文章末尾。没配辅助模型时它原样返回,不会失败
          const condensed = await condenseIfLong(page.text, input.intent)
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
