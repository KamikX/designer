import { streamText } from 'ai'
import type { WebContents } from 'electron'
import type {
  GroupMember,
  GroupSendInput,
  GroupStreamEvent,
  Message,
  SessionSettings
} from '../../shared/types'
import { isConfiguredGroupMembers } from '../../shared/group-members'
import { firstMention, mentionsToModelText, nextMention } from '../../shared/group-mentions'
import { getConversation, touchConversation } from '../db/repo/conversation'
import { createMessage, listMessages, updateMessage } from '../db/repo/message'
import { getModel } from '../db/repo/model'
import { getProviderRowById } from '../db/repo/provider'
import { getLanguageModel, errorMessage } from './registry'
import { buildTimeTools } from './time-tools'
import { buildLocalTools } from './local-tools'
import { listRoots } from '../workspace/roots'
import { labelFor, verbOf } from './tool-activity'
import { GroupChainGuard } from './group-chain'
import { resolveGroupAgent, type ResolvedGroupAgent } from './group-members'
import { scanSkills, skillRoots } from '../skills/scan'
import { skillCatalog } from '../skills/catalog'
import { buildSkillTools } from '../skills/tools'
import { RunTraceCollector } from './run-trace'
import { ToolBudgetGate, wrapToolsWithBudget } from './context-governor'
import { openaiCompatOptions } from './provider-options'
import type { AdapterType } from '../../shared/types'

/**
 * 多 agent 协作群组的编排。
 *
 * 模型:一个"聊天室"+ @ 接力。用户 @ 某个角色发起,该角色跑一轮
 * (人设 + 群聊记录 + 本地目录工具),产出 markdown 文档落库为一条群消息;
 * 它的输出末尾若 @ 了下一位成员,链条继续,直到 @用户 / 没人被 @ / 到达
 * 上限 / 用户中止。
 *
 * 群组的产出就是文档本身(消息即文档)。每位成员只拿自己的模型与文件技能；
 * 仍然没有 VFS、版本、MCP、联网和写文件工具。
 */

/** 单个 agent 一轮的工具调用上限。它只是读文档,不需要设计会话那么多 */
const MAX_TOOL_CALLS = 40

const running = new Map<string, AbortController>()

export function abortGroup(conversationId: string): void {
  running.get(conversationId)?.abort()
}

export function sendGroupMessage(sender: WebContents, input: GroupSendInput): void {
  const conversation = getConversation(input.conversationId)
  if (!conversation || conversation.kind !== 'group') throw new Error('群组不存在')
  if (running.has(input.conversationId))
    throw new Error('上一条接力还在进行中,先等它结束或点停止。')

  const members = resolveStoredMembers(conversation.settings?.members)
  const mentionMembers = members.map(memberMention)
  const emit = (event: GroupStreamEvent): void => {
    if (!sender.isDestroyed()) sender.send('group:stream', event)
  }

  // 用户消息先落库
  createMessage({
    conversationId: input.conversationId,
    role: 'user',
    parts: [{ type: 'text', text: input.text }],
    author: 'user'
  })
  touchConversation(input.conversationId)

  const first = firstMention(input.text, mentionMembers)
  if (!first) {
    // 没 @ 任何机器人就只是留言,不启动链条
    emit({ conversationId: input.conversationId, type: 'chain-done' })
    return
  }

  const abort = new AbortController()
  running.set(input.conversationId, abort)
  void runChain(input, first, members, emit, abort).finally(() => {
    running.delete(input.conversationId)
  })
}

async function runChain(
  input: GroupSendInput,
  firstMemberId: string,
  members: GroupMember[],
  emit: (e: GroupStreamEvent) => void,
  abort: AbortController
): Promise<void> {
  const conversationId = input.conversationId
  const membersById = new Map(members.map((member) => [member.id, member]))
  const mentionMembers = members.map(memberMention)
  let installedSkills: ReturnType<typeof scanSkills>
  try {
    installedSkills = scanSkills()
  } catch (err) {
    emit({ conversationId, type: 'error', message: errorMessage(err) })
    emit({ conversationId, type: 'chain-done' })
    return
  }
  const guard = new GroupChainGuard()
  let current: string | null = firstMemberId

  while (current && !abort.signal.aborted) {
    const guarded = guard.enter(current)
    if (!guarded.ok) {
      emit({
        conversationId,
        type: 'chain-stopped',
        reason: guarded.reason,
        message: guarded.message
      })
      return
    }

    const source = membersById.get(current)
    if (!source) break
    let agent: ResolvedGroupAgent | null = null
    let providerSlug: string | null = null
    let resolutionError: unknown = null
    let providerAdapter: AdapterType | undefined
    try {
      agent = resolveGroupAgent(source, getModel)
      const provider = getProviderRowById(agent.model.providerId)
      if (!provider) {
        throw new Error(`成员“${source.name}”使用的供应商不存在`)
      }
      providerSlug = provider.slug
      providerAdapter = provider.adapter as AdapterType
    } catch (err) {
      resolutionError = err
    }
    const message = createMessage({
      conversationId,
      role: 'assistant',
      parts: [],
      status: 'streaming',
      ...(agent ? { modelId: agent.model.modelId } : {}),
      ...(providerSlug ? { providerSlug } : {}),
      author: source.id
    })

    let text = ''
    /** 每一棒是一次独立 run:各有自己的模型与消息 */
    let trace: RunTraceCollector | null = null
    try {
      if (resolutionError) throw resolutionError
      if (!agent) throw resolutionError ?? new Error(`成员“${source.name}”解析失败`)
      trace = new RunTraceCollector({
        scene: 'group',
        messageId: message.id,
        conversationId,
        providerId: agent.model.providerId,
        providerSlug: providerSlug ?? '',
        modelId: agent.model.modelId,
        adapter: providerAdapter
      })
      trace.start()
      // 群组里没有"自动内置"的技能:builtin 设计技能也只在被显式勾选时生效
      const wantedSkills = new Set(agent.skillIds)
      const selectedSkills = installedSkills.filter((skill) => wantedSkills.has(skill.name))
      const userRoots = listRoots({ conversationId })
      const roots = [...userRoots, ...skillRoots(selectedSkills)]
      const catalog = skillCatalog(selectedSkills, agent.model.contextWindow)
      const system = buildAgentSystem(agent, members, userRoots.length > 0, catalog)
      emit({
        conversationId,
        type: 'agent-start',
        messageId: message.id,
        author: agent.id,
        system
      })

      const result = streamText({
        model: getLanguageModel(agent.model.providerId, agent.model.modelId),
        system,
        // OpenAI 协议兼容参数,与设计/纯聊天同一套(见 provider-options.ts)。
        // 群组 agent 带工具必然多步,漏掉它就会复发 rs_ 条目找不到的报错
        providerOptions: { openai: openaiCompatOptions() },
        messages: [
          {
            role: 'user',
            content: transcript(conversationId, message.id, agent.name, mentionMembers)
          }
        ],
        abortSignal: abort.signal,
        onLanguageModelCallStart: ({ callId }) => trace?.modelCallStart(callId),
        onLanguageModelCallEnd: (event) =>
          trace?.stepEnd(event.callId, event.usage, {
            finishReason: event.finishReason,
            responseTimeMs: event.performance?.responseTimeMs ?? null,
            timeToFirstOutputMs: event.performance?.timeToFirstOutputMs ?? null
          }),
        onToolExecutionStart: (event) => {
          trace?.toolExecutionStart(event.toolCall.toolCallId)
          emit({
            conversationId,
            type: 'tool-exec',
            messageId: message.id,
            callId: event.toolCall.toolCallId,
            label: verbOf(event.toolCall.toolName)
          })
        },
        // 与设计会话同一套硬预算语义:同步预留名额,单 step 超发的并行
        // 调用原地拒绝,不产生副作用
        tools: wrapToolsWithBudget(
          {
            ...buildTimeTools(),
            ...buildLocalTools(roots, {
              canSeeImages: agent.model.abilities.includes('vision'),
              intent: input.text
            }),
            ...buildSkillTools(selectedSkills)
          },
          new ToolBudgetGate(MAX_TOOL_CALLS)
        ),
        stopWhen: ({ steps }) => steps.reduce((n, s) => n + s.toolCalls.length, 0) >= MAX_TOOL_CALLS
      })

      let streamError: unknown = null
      for await (const part of result.fullStream) {
        if (part.type === 'error') {
          streamError = part.error
          break
        }
        if (part.type === 'abort') break
        switch (part.type) {
          case 'text-delta':
            trace?.markFirstOutput()
            text += part.text
            emit({ conversationId, type: 'delta', messageId: message.id, text: part.text })
            break
          case 'tool-input-start':
            trace?.toolInputStart(part.id, part.toolName)
            emit({
              conversationId,
              type: 'tool-start',
              messageId: message.id,
              callId: part.id,
              label: verbOf(part.toolName)
            })
            break
          case 'tool-call':
            trace?.toolInputStart(part.toolCallId, part.toolName)
            trace?.toolInputEnd(part.toolCallId, part.input)
            emit({
              conversationId,
              type: 'tool-update',
              messageId: message.id,
              callId: part.toolCallId,
              label: labelFor(part.toolName, part.input as Record<string, unknown>)
            })
            break
          case 'tool-result':
            trace?.toolExecutionEnd(part.toolCallId, {
              status: 'success',
              outputChars: typeof part.output === 'string' ? part.output.length : null
            })
            emit({
              conversationId,
              type: 'tool-end',
              messageId: message.id,
              callId: part.toolCallId,
              ok: true,
              status: 'success'
            })
            break
        }
      }
      if (streamError) throw streamError

      trace?.finish(abort.signal.aborted ? 'aborted' : 'complete')
      updateMessage(message.id, {
        parts: [{ type: 'text', text }],
        status: abort.signal.aborted ? 'aborted' : 'complete'
      })
      if (!abort.signal.aborted) {
        emit({ conversationId, type: 'agent-done', messageId: message.id })
      }
      touchConversation(conversationId)

      // 从**末尾**找下一棒:开头的 @ 往往是在回应上一位,结尾的才是移交
      current = abort.signal.aborted ? null : nextMention(text, mentionMembers, agent.id)
    } catch (err) {
      trace?.finish(abort.signal.aborted ? 'aborted' : 'error')
      updateMessage(message.id, {
        parts: [{ type: 'text', text }],
        status: abort.signal.aborted ? 'aborted' : 'error'
      })
      if (!abort.signal.aborted) {
        emit({ conversationId, type: 'error', message: errorMessage(err), messageId: message.id })
      }
      current = null
    }
  }

  emit({ conversationId, type: 'chain-done' })
}

/**
 * 群聊记录 → 单条 transcript 文本。
 *
 * 不映射成多条 user 消息:群里的发言本来就不满足"一问一答"的角色交替,
 * 有些供应商的 API 会直接拒绝连续同角色消息。拼成一份带【发言人】前缀的
 * 记录最稳,也最接近"读群聊"的心智。
 */
function transcript(
  conversationId: string,
  excludeId: string,
  selfName: string,
  members: ReturnType<typeof memberMention>[]
): string {
  const membersById = new Map(members.map((member) => [member.id, member]))
  const nameOf = (author: string | null | undefined): string =>
    author === 'user' || !author ? '用户' : (membersById.get(author)?.name ?? author)

  const lines = listMessages(conversationId)
    .filter((m: Message) => m.id !== excludeId && m.status !== 'streaming')
    .map((m: Message) => {
      const text = m.parts
        .map((p) => (p.type === 'text' ? p.text : ''))
        .join('')
        .trim()
      return text ? `【${nameOf(m.author)}】\n${mentionsToModelText(text, members)}` : ''
    })
    .filter(Boolean)

  return `以下是群聊记录(按时间顺序):\n\n${lines.join('\n\n---\n\n')}\n\n---\n\n现在轮到你(${selfName})发言。按你的职责与协作协议产出文档。`
}

function buildAgentSystem(
  agent: ResolvedGroupAgent,
  members: readonly GroupMember[],
  hasRoots: boolean,
  catalog: string
): string {
  const roster = members.map((member) => `@${member.name}(${member.duty})`).join('、')

  return [
    agent.persona,
    `## 协作协议

你在一个多角色协作群里。成员:${roster},以及 @用户(发起人,最终验收者)。

- **只产出 markdown 文档**,不写实现代码(字段表、结构树、伪代码可以)。文档以一级标题开头(如「# 需求文档:xxx」)。
- 直接输出文档本身,不要客套与自我介绍。
- 群聊记录里【角色名】开头的是各成员的发言,你自己的历史发言也在其中,不要重复已有内容,在其基础上推进。
- 完成后在消息**末尾单独一行**决定下一棒:还需要谁接力就写「@角色名 一句话交代要做什么」;整条链路完成或需要用户决策时写「@用户 一句话总结」。**一次只 @ 一位。**`,
    hasRoots
      ? '- 用户授权了本地目录:先用 list_local / read_local_file 读里面的文档定位背景,再动笔。'
      : '- 用户没有授权本地目录,基于群聊内容做合理假设,并把关键假设写在文档开头。',
    catalog
  ].join('\n\n')
}

function resolveStoredMembers(members: SessionSettings['members']): GroupMember[] {
  return isConfiguredGroupMembers(members) ? members : []
}

function memberMention(member: GroupMember): { id: string; name: string } {
  return { id: member.id, name: member.name }
}
