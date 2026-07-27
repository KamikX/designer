import type { ModelMessage } from 'ai'
import type { AdapterType } from '../../shared/types'

/**
 * Anthropic 的提示词缓存断点。
 *
 * ## 为什么必须显式打
 *
 * Anthropic 的缓存是**断点制**:请求里没有任何 `cache_control` 标记就一次都不缓存,
 * cache_creation / cache_read 恒为 0。我们此前一个断点都没打,所以走 anthropic 适配器
 * 的模型缓存命中率结构性为零——不是"命中不好",是根本没开。
 *
 * OpenAI 协议那边是服务端自动缓存,不认这个字段,所以这里只对 anthropic 生效;
 * 别的适配器原样返回,连对象都不复制。
 *
 * ## 为什么要打好几个,而不是只标最后一条
 *
 * 一个断点只会**向前回溯至多 20 个 content block** 去找已有的缓存条目。而工具协议下
 * 一轮几十次调用,每次调用产生 tool-call + tool-result 两个块:10 次调用就是 20 块,
 * 刚好把窗口用完;40 次就是 80 块,只标最后一条的话,下一次请求的断点根本够不着
 * 上一次那个,缓存写了从来没被读过。
 *
 * 所以从尾部往前每积够 STRIDE 个块补一个断点。Anthropic 每请求最多 4 个断点
 * (超了会被 provider 静默忽略并告警),所以这里也只放 4 个:尾部密、越往前越稀,
 * 正好对上"新内容都在尾部"的实际形状。
 */

/** Anthropic 每请求的断点上限 */
const MAX_BREAKPOINTS = 4
/**
 * 断点间隔(content block 数)。硬窗口是 20,留 5 块余量——单个 step 里
 * 并行调用的块数是模型定的,不留余量会正好卡在边界上。
 */
const STRIDE = 15

/** 一条消息占几个 content block。字符串正文算一块 */
function blockCount(message: ModelMessage): number {
  return Array.isArray(message.content) ? Math.max(1, message.content.length) : 1
}

function markCacheBreakpoint(message: ModelMessage): ModelMessage {
  const provider = message.providerOptions ?? {}
  return {
    ...message,
    providerOptions: {
      ...provider,
      anthropic: { ...(provider.anthropic ?? {}), cacheControl: { type: 'ephemeral' } }
    }
  } as ModelMessage
}

/**
 * 给消息数组打上缓存断点,返回新数组(不改入参)。
 *
 * 标在消息上而不是 part 上:provider 会把它落到该消息的最后一个 block,
 * 语义正好是"缓存到这条消息为止的全部内容"——包括 tools 与 system,
 * 它们在渲染顺序里排在 messages 前面。
 */
export function withCacheBreakpoints(
  messages: ModelMessage[],
  adapter: AdapterType | undefined
): ModelMessage[] {
  if (adapter !== 'anthropic' || messages.length === 0) return messages

  const marks = new Set<number>()
  let since = STRIDE // 先让最后一条必被标上:多轮对话的标准打法

  for (let index = messages.length - 1; index >= 0; index--) {
    since += blockCount(messages[index])
    if (since < STRIDE) continue
    marks.add(index)
    since = 0
    if (marks.size >= MAX_BREAKPOINTS) break
  }

  return messages.map((message, index) =>
    marks.has(index) ? markCacheBreakpoint(message) : message
  )
}
