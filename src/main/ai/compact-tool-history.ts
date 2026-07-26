import { modelMessageSchema } from 'ai'
import type { ModelMessage } from 'ai'
import type { ToolFailureSummary, WriteSummary } from './run-context-ledger'

/**
 * 工具历史压缩:在下一次模型请求前,把已完成/已失效的大体积工具调用
 * 从消息里安全地摘掉。
 *
 * ## 为什么值得做
 *
 * 每个 step 都会重发整个对话,一次 write_file 的 content 是整份文件,
 * 一次 apply_patch 的入参是整个补丁——它们完成之后就只是"发生过的事实",
 * 却在后面每一步反复计费。实测单轮累计输入能到 45 万~68 万 token,
 * 大头就是这些。
 *
 * ## 合法形态铁律
 *
 * 1. tool-call 与 tool-result 按 toolCallId **成对**删除,绝不产生孤儿;
 * 2. 只摘 part,不整条丢弃混着文本/其他并行调用的消息;
 * 3. 过滤后为空的 assistant/tool 消息才移除;
 * 4. 压缩掉的事实合并进**唯一、可替换**的 <tool_ledger> user 注记;
 * 5. 输出的每条消息都过 modelMessageSchema,喂给下一 step 前就炸在测试里。
 */

export const TOOL_LEDGER_TAG = '<tool_ledger>'

export interface CompactionContext {
  completedWrites: WriteSummary[]
  recentErrors: ToolFailureSummary[]
  activatedSkills: Set<string>
}

/** 完整参数/结果在完成后就没有留存价值的写类工具 */
const WRITE_TOOLS = new Set([
  'write_file',
  'edit_file',
  'multi_edit_file',
  'apply_patch',
  'apply_string_edits',
  'move_file',
  'copy_file',
  'delete_file',
  'revert_file'
])

/** 结果随文件修订而失效的读类工具 */
const READ_TOOLS = new Set(['read_file', 'get_range', 'capture_range', 'outline_file'])

interface CallInfo {
  toolName: string
  input: unknown
  /** 所在 assistant 消息的下标,判断先后 */
  order: number
}

type Part = { type?: string; toolCallId?: string; toolName?: string; input?: unknown }

function pathOf(input: unknown): string | null {
  if (!input || typeof input !== 'object') return null
  const path = (input as Record<string, unknown>).path
  return typeof path === 'string' ? path : null
}

function skillNameOf(input: unknown): string | null {
  if (!input || typeof input !== 'object') return null
  const name = (input as Record<string, unknown>).name
  return typeof name === 'string' ? name : null
}

export function compactToolHistory(
  messages: ModelMessage[],
  ctx: CompactionContext
): ModelMessage[] {
  // 1. 索引全部 tool-call。顺序精确到 part:同一步里"先读后写",
  // 那个读的结果同样已经过期(执行是按声明顺序串行的)
  const calls = new Map<string, CallInfo>()
  let sequence = 0
  for (const message of messages) {
    if (message.role !== 'assistant' || !Array.isArray(message.content)) continue
    for (const part of message.content as Part[]) {
      if (part.type === 'tool-call' && part.toolCallId && part.toolName) {
        calls.set(part.toolCallId, {
          toolName: part.toolName,
          input: part.input,
          order: sequence++
        })
      }
    }
  }

  // 2. 每个文件"最后一次写调用"的位置:之前的读结果都失效了
  const lastWriteOrder = new Map<string, number>()
  let lastAnyWriteOrder = -1
  for (const info of calls.values()) {
    if (!WRITE_TOOLS.has(info.toolName)) continue
    lastAnyWriteOrder = Math.max(lastAnyWriteOrder, info.order)
    const path = pathOf(info.input)
    if (path) {
      lastWriteOrder.set(path, Math.max(lastWriteOrder.get(path) ?? -1, info.order))
    }
  }

  // 3. 选出要压缩的 callId
  const seenSkillBodies = new Set<string>()
  const compactIds = new Set<string>()
  for (const [id, info] of calls) {
    if (WRITE_TOOLS.has(info.toolName)) {
      // 写调用完成即压缩:成功事实与失败错误都由账本承载
      compactIds.add(id)
      continue
    }
    if (READ_TOOLS.has(info.toolName)) {
      const path = pathOf(info.input)
      const staleAt = path ? (lastWriteOrder.get(path) ?? -1) : -1
      if (staleAt > info.order) compactIds.add(id)
      continue
    }
    if (info.toolName === 'search_files') {
      // 搜索跨文件:其后发生过任何写,行列与预览都不再可信
      if (lastAnyWriteOrder > info.order) compactIds.add(id)
      continue
    }
    if (info.toolName === 'activate_skill') {
      const name = skillNameOf(info.input)
      if (!name) continue
      // 首个正文保留(它是本轮的知识来源),后续重复激活压成账本短事实
      if (seenSkillBodies.has(name)) compactIds.add(id)
      else seenSkillBodies.add(name)
    }
  }

  // 4. 按 part 过滤,成对移除;顺带摘掉旧账本
  const out: ModelMessage[] = []
  for (const message of messages) {
    if (
      message.role === 'user' &&
      typeof message.content === 'string' &&
      message.content.includes(TOOL_LEDGER_TAG)
    ) {
      continue
    }
    if (
      (message.role === 'assistant' || message.role === 'tool') &&
      Array.isArray(message.content)
    ) {
      const kept = (message.content as Part[]).filter((part) => {
        if (
          (part.type === 'tool-call' ||
            part.type === 'tool-result' ||
            part.type === 'tool-approval-request') &&
          part.toolCallId
        ) {
          return !compactIds.has(part.toolCallId)
        }
        return true
      })
      if (kept.length === 0) continue
      if (kept.length !== message.content.length) {
        out.push({ ...message, content: kept } as ModelMessage)
        continue
      }
    }
    out.push(message)
  }

  // 5. 追加唯一账本(有可写事实才追加)
  const ledger = renderLedger(ctx, compactIds.size)
  if (ledger) out.push({ role: 'user', content: ledger })

  // 6. 出门前逐条验:宁可在这里炸,也不能把非法消息交给下一 step
  for (const message of out) modelMessageSchema.parse(message)
  return out
}

function renderLedger(ctx: CompactionContext, compactedCount: number): string | null {
  const lines: string[] = []
  for (const write of ctx.completedWrites) {
    lines.push(
      `- 已完成写入:${write.path} @rev${write.revision}(${write.tool}${write.chars ? `,${write.chars} 字符` : ''})`
    )
  }
  for (const error of ctx.recentErrors) {
    lines.push(`- 失败记录:${error.tool} ${error.code}${error.path ? ` @ ${error.path}` : ''}`)
  }
  for (const skill of ctx.activatedSkills) {
    lines.push(`- 技能 ${skill} 已激活,正文见上文,仍然有效,不要重复激活`)
  }
  if (lines.length === 0 && compactedCount === 0) return null
  if (compactedCount > 0) {
    lines.push(`- 已清理 ${compactedCount} 条完成/过期的工具调用记录以节省上下文`)
  }
  return [
    TOOL_LEDGER_TAG,
    '(运行时工具账本:系统注记,不是用户的新要求。以下是本轮已确认的事实。)',
    ...lines,
    '</tool_ledger>'
  ].join('\n')
}
