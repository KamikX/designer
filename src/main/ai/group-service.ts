import { streamText } from 'ai'
import type { WebContents } from 'electron'
import type {
  GroupMember,
  GroupSendInput,
  GroupStreamEvent,
  SessionSettings
} from '../../shared/types'
import { isConfiguredGroupMembers } from '../../shared/group-members'
import {
  deliverableProgress,
  groupDeliverables,
  type DeliverableEntry
} from '../../shared/group-deliverables'
import {
  mentionAssignments,
  nextMentions,
  type MentionAssignment
} from '../../shared/group-mentions'
import { getConversation, touchConversation } from '../db/repo/conversation'
import { createMessage, listMessages, updateMessage } from '../db/repo/message'
import { getModel } from '../db/repo/model'
import { getProviderRowById } from '../db/repo/provider'
import { getLanguageModel, errorMessage } from './registry'
import { isTransientAiError } from './ai-errors'
import { buildGroupTranscript } from './group-transcript'
import { maybeUpdateGroupDigest } from './group-digest'
import { getGroupDigest } from '../db/repo/group-digest'
import { buildTimeTools } from './time-tools'
import { buildLocalTools } from './local-tools'
import { buildGroupHistoryTools } from './group-tools'
import { listRoots } from '../workspace/roots'
import { labelFor, verbOf } from './tool-activity'
import { GroupChainGuard, HopScheduler } from './group-chain'
import { withCacheBreakpoints } from './prompt-cache'
import { resolveGroupAgent, type ResolvedGroupAgent } from './group-members'
import { scanSkills, skillRoots } from '../skills/scan'
import { skillCatalog } from '../skills/catalog'
import { buildSkillTools } from '../skills/tools'
import { RunTraceCollector } from './run-trace'
import {
  ToolBudgetGate,
  effectiveToolCallLimit,
  resolveToolLimits,
  wrapToolsWithBudget
} from './context-governor'
import { readConfig } from '../config'
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

/**
 * 单个 agent 一棒的工具调用上限。
 *
 * 群组没有项目可覆盖,直接跟随全局配置(0 = 不限)。它只是读文档和技能,
 * 用不到设计会话那么多次,但被熔断的表现是"这一棒话说一半就停",
 * 和设计会话同样难受,所以不该再写死。
 */
function groupToolCallLimit(): number {
  const limit = effectiveToolCallLimit(null, readConfig().toolCallLimit)
  return resolveToolLimits(limit).hard
}

/**
 * 单棒的最大尝试次数(1 次正常 + 2 次重试)与退避基数。
 *
 * 群组一棒天然无状态:群聊记录每次从库重建,工具全是只读——重跑一遍没有
 * 副作用。中转站的瞬时故障(流中途 upstream_error、5xx、限流)在这里原地
 * 消化,不值得打断整条接力链让用户手动重新 @ 一遍。
 */
const HOP_MAX_ATTEMPTS = 3
const RETRY_BASE_DELAY_MS = 1500

const running = new Map<string, AbortController>()

export function abortGroup(conversationId: string): void {
  running.get(conversationId)?.abort()
}

/** 编辑群组前的检查:每一棒开始时都重读成员配置,链跑一半改配置=中途换人设 */
export function isGroupChainRunning(conversationId: string): boolean {
  return running.has(conversationId)
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

  const assignments = mentionAssignments(input.text, mentionMembers)
  if (assignments.length === 0) {
    // 没 @ 任何机器人就只是留言,不启动链条
    emit({ conversationId: input.conversationId, type: 'chain-done' })
    return
  }

  const abort = new AbortController()
  running.set(input.conversationId, abort)
  void runFanOut(input, assignments, members, emit, abort).finally(() => {
    running.delete(input.conversationId)
  })
}

/** 一次 run 里所有分支共用的东西。分支很多,逐个透传参数不如收成一个 */
interface BranchContext {
  conversationId: string
  /** 用户这条消息的原文,本地文件工具用它判断意图 */
  userText: string
  members: GroupMember[]
  membersById: Map<string, GroupMember>
  mentionMembers: { id: string; name: string }[]
  installedSkills: ReturnType<typeof scanSkills>
  emit: (e: GroupStreamEvent) => void
  abort: AbortController
  /** 并发上限 + 同一成员串行,见 group-chain.ts */
  scheduler: HopScheduler
}

/** 这一棒在整轮接力里的位置,注入提示词让模型自己收敛 */
type HopBudget = ReturnType<GroupChainGuard['budget']>

/** 这一棒是谁、为什么被叫起来的 */
interface BranchOrigin {
  /** 交接人:'用户' 或某个成员名 */
  from: string
  /** 交代的那句话。空串表示只 @ 了名字没说要干嘛 */
  instruction: string
  /** 和这一棒**同时**开跑的其他成员名,写进协作协议让它知道自己在并行 */
  peers: string[]
  /**
   * 汇合棒:这一棒不是被谁 @ 来的,而是它自己派出去的并行分支都回来了。
   * 值是它当时派活的成员名。
   */
  mergeOf?: string[]
}

/**
 * 一条用户消息 → 一棵接力树。
 *
 * 被 @ 的每个人各起一条分支同时开跑;每棒结束后它 @ 的人再各起子分支。
 * 并行的兄弟**看不到彼此本轮的产出**(transcript 只收已完成的消息),这一点
 * 写进了协作协议由模型自己处理——需要对方的结果就在末尾 @ 对方,那时对方
 * 接棒就能看到。
 */
async function runFanOut(
  input: GroupSendInput,
  assignments: MentionAssignment[],
  members: GroupMember[],
  emit: (e: GroupStreamEvent) => void,
  abort: AbortController
): Promise<void> {
  const conversationId = input.conversationId
  let installedSkills: ReturnType<typeof scanSkills>
  try {
    installedSkills = scanSkills()
  } catch (err) {
    emit({ conversationId, type: 'error', message: errorMessage(err) })
    emit({ conversationId, type: 'chain-done' })
    return
  }

  const ctx: BranchContext = {
    conversationId,
    userText: input.text,
    members,
    membersById: new Map(members.map((member) => [member.id, member])),
    mentionMembers: members.map(memberMention),
    installedSkills,
    emit,
    abort,
    scheduler: new HopScheduler()
  }

  const root = new GroupChainGuard()
  await settleBranches(
    ctx,
    assignments.map((assignment) =>
      runBranch(ctx, assignment, root.fork(), {
        from: '用户',
        instruction: assignment.instruction,
        peers: peerNames(ctx, assignments, assignment.memberId)
      })
    )
  )
  // 全部分支跑完才算结束:chain-done 是渲染层唯一的"可以再发言了"信号
  emit({ conversationId, type: 'chain-done' })
}

/**
 * 等所有分支落定。
 *
 * 用 allSettled 而不是 all:all 会在第一个 reject 时**立刻返回**,这边接着发
 * chain-done 解锁输入框,而别的分支还在写消息——用户发下一条会被主进程以
 * "上一条还在跑"顶回来。意外抛出的错(编排自身的 bug,不是模型的)也要走
 * error 事件报出去,不能只留在控制台。
 */
async function settleBranches(ctx: BranchContext, branches: Promise<void>[]): Promise<void> {
  const results = await Promise.allSettled(branches)
  for (const result of results) {
    if (result.status !== 'rejected' || ctx.abort.signal.aborted) continue
    ctx.emit({
      conversationId: ctx.conversationId,
      type: 'error',
      message: errorMessage(result.reason)
    })
  }
}

/** 同一批被点名的其他人(展示名)。给"你在和谁并行"的提示用 */
function peerNames(ctx: BranchContext, batch: MentionAssignment[], selfId: string): string[] {
  return batch
    .filter((item) => item.memberId !== selfId)
    .map((item) => ctx.membersById.get(item.memberId)?.name)
    .filter((name): name is string => !!name)
}

/**
 * 一条分支:跑一棒,再按这棒 @ 的人分叉出子分支并发跑下去。
 *
 * guard 每分叉一次 fork 一份:它判的是"**这条路径**在不在绕圈",兄弟分支
 * 共用一个对象会互相串味。
 */
async function runBranch(
  ctx: BranchContext,
  assignment: MentionAssignment,
  guard: GroupChainGuard,
  origin: BranchOrigin
): Promise<void> {
  if (ctx.abort.signal.aborted) return
  const source = ctx.membersById.get(assignment.memberId)
  if (!source) return

  // 拦停提示是给用户看的,用成员名不用 ULID
  const guarded = guard.enter(source.id, source.name)
  if (!guarded.ok) {
    /*
     * 汇合棒被拦下时**不报拦停**:各分支的文档都已经产出并落库了,少一次
     * 合并是降级,不是失败。这时候弹一条"接力已自动停止"只会让用户以为
     * 刚才那批活白干了。
     */
    if (origin.mergeOf) return
    ctx.emit({
      conversationId: ctx.conversationId,
      type: 'chain-stopped',
      reason: guarded.reason,
      message: guarded.message,
      // 带上被拦的成员,渲染层给一键续棒(新消息开新链,guard 随链重置)
      nextMemberId: source.id
    })
    return
  }

  // 同一成员同一时刻只跑一棒:两条分支同时点到同一个人时后到的排队等
  const budget = guard.budget()
  const text = await ctx.scheduler.run(source.id, () => runHop(ctx, source, origin, budget))
  if (text == null || ctx.abort.signal.aborted) return

  const nexts = nextMentions(text, ctx.mentionMembers, source.id)
  await settleBranches(
    ctx,
    nexts.map((next) =>
      runBranch(ctx, next, guard.fork(), {
        from: source.name,
        instruction: next.instruction,
        peers: peerNames(ctx, nexts, next.memberId)
      })
    )
  )

  /*
   * 汇合:并行派出去的活都回来了,把控制权交回**派活的那个人**。
   *
   * 不加这一棒的话,并行的收益只有速度:用户看到 N 篇互不知道对方存在的
   * 文档,合并、挑冲突全靠他自己脑补。而派活的人天然就是收活的人——它知道
   * 当初为什么拆成这几条,也是唯一能判断"合起来够不够"的人。
   *
   * 只在**真分叉**(≥2 条)时汇合:一条的接力本来就是线性的,那位手上已经
   * 有全部上下文,再叫回来只是白烧一棒。
   */
  if (nexts.length < 2 || ctx.abort.signal.aborted) return
  await runBranch(
    ctx,
    { memberId: source.id, instruction: '' },
    // 不 fork:汇合是这条路径的延续,不是新分支
    guard,
    {
      from: source.name,
      instruction: '',
      peers: [],
      mergeOf: nexts
        .map((next) => ctx.membersById.get(next.memberId)?.name)
        .filter((name): name is string => !!name)
    }
  )
}

/**
 * 跑一棒:落一条流式消息,把 agent 的产出流回渲染层。
 *
 * @returns 这一棒的正文;出错或被中止返回 null(调用方据此结束该分支)
 */
async function runHop(
  ctx: BranchContext,
  source: GroupMember,
  origin: BranchOrigin,
  budget: HopBudget
): Promise<string | null> {
  const { conversationId, members, mentionMembers, installedSkills, emit, abort } = ctx
  {
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
    /** 每次尝试是一次独立 run:重试在观测里可见,各有自己的步与用量 */
    let trace: RunTraceCollector | null = null
    try {
      if (resolutionError) throw resolutionError
      if (!agent) throw resolutionError ?? new Error(`成员“${source.name}”解析失败`)
      // 与重试无关的一次性准备。群组里没有"自动内置"的技能:builtin 设计
      // 技能也只在被显式勾选时生效
      const wantedSkills = new Set(agent.skillIds)
      const selectedSkills = installedSkills.filter((skill) => wantedSkills.has(skill.name))
      const userRoots = listRoots({ conversationId })
      const roots = [...userRoots, ...skillRoots(selectedSkills)]
      const catalog = skillCatalog(selectedSkills, agent.model.contextWindow)
      const system = buildAgentSystem(
        agent,
        members,
        userRoots.length > 0,
        catalog,
        origin.peers,
        budget,
        origin.mergeOf,
        groupDeliverables(listMessages(conversationId), members)
      )
      // 每一棒重新读一次:用户可能在接力途中把上限调了
      const toolCallLimit = groupToolCallLimit()
      const content = buildGroupTranscript({
        messages: listMessages(conversationId),
        excludeId: message.id,
        selfName: agent.name,
        members: mentionMembers,
        contextWindow: agent.model.contextWindow,
        loadDigest: () => getGroupDigest(conversationId),
        // 并行下"上一棒"未必是交接给我的那位(兄弟分支可能后收棒),
        // 所以交接指令由编排显式带下来,而不是让 transcript 去猜
        ...(origin.instruction
          ? { assignment: { from: origin.from, line: origin.instruction } }
          : {})
      })

      for (let attempt = 1; ; attempt++) {
        text = ''
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
        if (attempt === 1) {
          emit({
            conversationId,
            type: 'agent-start',
            messageId: message.id,
            author: agent.id,
            system
          })
        }

        try {
          const result = streamText({
            model: getLanguageModel(agent.model.providerId, agent.model.modelId),
            system,
            // OpenAI 协议兼容参数,与设计/纯聊天同一套(见 provider-options.ts)。
            // 群组 agent 带工具必然多步,漏掉它就会复发 rs_ 条目找不到的报错
            providerOptions: { openai: openaiCompatOptions() },
            /*
             * 群聊记录每棒都不一样,跨棒缓存不了;但**一棒之内**每次工具调用都要
             * 把这份几万字的记录重发一遍,断点打在它上面就能把 system + tools +
             * 记录整段复用给后面每一步。
             */
            messages: withCacheBreakpoints([{ role: 'user', content }], providerAdapter),
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
                ...buildGroupHistoryTools(conversationId, mentionMembers),
                ...buildLocalTools(roots, {
                  canSeeImages: agent.model.abilities.includes('vision'),
                  intent: ctx.userText
                }),
                ...buildSkillTools(selectedSkills)
              },
              new ToolBudgetGate(toolCallLimit)
            ),
            stopWhen: ({ steps }) =>
              steps.reduce((n, s) => n + s.toolCalls.length, 0) >= toolCallLimit
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
          break
        } catch (err) {
          trace.finish(abort.signal.aborted ? 'aborted' : 'error')
          trace = null
          const retryable =
            !abort.signal.aborted && attempt < HOP_MAX_ATTEMPTS && isTransientAiError(err)
          if (!retryable) throw err
          await backoff(RETRY_BASE_DELAY_MS * attempt, abort.signal)
          if (abort.signal.aborted) throw err
          // 等真正开始下一次尝试才通知渲染层清半截正文:退避期间用户
          // 还能看到已生成的内容,不会平白闪空
          emit({
            conversationId,
            type: 'agent-retry',
            messageId: message.id,
            attempt: attempt + 1,
            message: errorMessage(err)
          })
        }
      }

      trace?.finish(abort.signal.aborted ? 'aborted' : 'complete')
      updateMessage(message.id, {
        parts: [{ type: 'text', text }],
        status: abort.signal.aborted ? 'aborted' : 'complete'
      })
      if (!abort.signal.aborted) {
        emit({ conversationId, type: 'agent-done', messageId: message.id })
        // 收棒后台滚动更新前情纪要,与下一棒并行;失败静默,下一棒退回机械折叠
        void maybeUpdateGroupDigest({
          conversationId,
          members: mentionMembers,
          providerId: agent.model.providerId,
          modelId: agent.model.modelId,
          contextWindow: agent.model.contextWindow
        })
      }
      touchConversation(conversationId)

      // 正文交回分支:调用方从**末尾**找下一棒(开头的 @ 往往是在回应上一位)
      return abort.signal.aborted ? null : text
    } catch (err) {
      trace?.finish(abort.signal.aborted ? 'aborted' : 'error')
      updateMessage(message.id, {
        parts: [{ type: 'text', text }],
        status: abort.signal.aborted ? 'aborted' : 'error'
      })
      if (!abort.signal.aborted) {
        // 一棒失败只结束它所在的分支,别的分支照常跑完
        emit({ conversationId, type: 'error', message: errorMessage(err), messageId: message.id })
      }
      return null
    }
  }
}

/**
 * 接力预算写给模型看。
 *
 * 以前这几个数只活在 GroupChainGuard 里,模型完全不知道自己是第几棒、还剩几棒
 * ——于是"@ 下一位"永远是零成本的默认动作,而"@用户 收尾"需要一个更强的判断。
 * 规则本身不对称,讨论自然停不下来,最后只能被 guard 砍断(用户拿到一堆半成品)。
 *
 * 剩 ≤2 棒时把话说死:不许再交接。这是**给模型的**硬规则,guard 那道闸照旧兜底。
 */
function budgetSection(budget: HopBudget): string {
  const head = `## 本轮接力预算\n\n这是第 ${budget.hop} 棒,整轮最多 ${budget.totalLimit} 棒,**你之后还剩 ${budget.remaining} 棒**。`
  if (budget.remaining <= 2) {
    return `${head}

**预算见底了,这一棒必须收口**:把当前结论整理成可交付的样子,末尾写「@用户 一句话总结 + 未决事项清单」。不要再 @ 任何成员——再交接会被系统拦停,用户只会拿到一份半成品。`
  }
  return `${head}

按剩余棒数安排:剩得多可以把事情做透,剩得少就先保证手上这份文档是完整可交付的。每一棒都要有实质推进——如果你发现只剩下"还可以再优化"这类建议,那就是该收口了,直接 @用户。`
}

/**
 * 汇合棒的指令。
 *
 * 两条硬规则都是防同一件事——**把合并做成重写**:
 * 模型看到三份文档,最省事的做法是自己重抄一遍拼成第四份,于是产出翻倍、
 * 原作者的判断被悄悄改掉、后面的人分不清哪份才算数。合并的价值在**对照**
 * (谁和谁打架、还缺什么),不在再生产。
 */
function mergeSection(branches: readonly string[]): string {
  return `## 这一棒是汇合

你之前派出去的并行分支都回来了:${branches.map((name) => `@${name}`).join('、')}。他们的产出就在上面的群聊记录里,现在由你收口。

要做的三件事:
1. **对照**:他们的结论有没有互相打架(同一张表两种字段、同一个接口两种签名、同一个假设两种取值)。有冲突就逐条列出来,并给出你的裁决和理由。
2. **补缺**:对着当初派活的目标看还缺什么。缺的那块具体是什么、该谁做,写清楚。
3. **定去向**:够交付了就写「@用户 一句话总结」;确实还缺一块才 @ 对应的成员,并说清要什么。

三条硬规则:
- **不要重写他们的文档**。你的产出是一份**汇总**:冲突清单 + 裁决 + 缺口 + 去向。要引用就用「见【角色名】的 xx 小节」,不要把原文抄进来。
- **用二级标题开头**(如「## 汇总:xxx」),不要用一级标题。一级标题是各成员**交付物**的标记,汇总不是一份新交付物——写成一级标题会把你自己那份专业文档从交付清单里挤掉。
- **没有冲突、也没有缺口,就直接 @用户 收口**。"再打磨一下"不是缺口。`
}

/**
 * 本轮交付清单。
 *
 * 剩余棒数只是**压力**,清单才是**完成的定义**——没有它,"这件事整体完成
 * 了没有"这个判断根本无从下手:后端工程师不知道前端够不够,测试工程师
 * 看不到产品目标。清单摆出来,每个人都能看到全局进度,收口才有依据。
 *
 * 从消息派生,不额外维护状态(见 shared/group-deliverables.ts)。
 */
function checklistSection(entries: readonly DeliverableEntry[]): string {
  if (entries.length === 0) return ''
  const { delivered, total } = deliverableProgress(entries)
  const lines = entries.map((entry) =>
    entry.status === 'delivered'
      ? `- 已交 ${entry.deliverable}(@${entry.memberName}):《${entry.title}》`
      : `- **未交** ${entry.deliverable}(@${entry.memberName})`
  )
  const tail =
    delivered === total
      ? '清单已经齐了。除非你手上这份还没写完,否则该收口了:@用户 一句话总结。'
      : '还有未交的项。你要么补上属于你的那份,要么 @ 该交的那位——不要开新的话题。'
  return `## 本轮交付清单(${delivered}/${total})\n\n${lines.join('\n')}\n\n${tail}\n\n交付物的标记是**一级标题**:你这份文档要以「# 标题」开头才会被算作交付。`
}

function buildAgentSystem(
  agent: ResolvedGroupAgent,
  members: readonly GroupMember[],
  hasRoots: boolean,
  catalog: string,
  peers: readonly string[] = [],
  budget?: HopBudget,
  mergeOf?: readonly string[],
  checklist: readonly DeliverableEntry[] = []
): string {
  const roster = members.map((member) => `@${member.name}(${member.duty})`).join('、')

  return [
    agent.persona,
    `## 协作协议

你在一个多角色协作群里。成员:${roster},以及 @用户(发起人,最终验收者)。

- **只产出 markdown 文档**,不写实现代码(字段表、结构树、伪代码可以)。文档以一级标题开头(如「# 需求文档:xxx」)。
- 直接输出文档本身,不要客套与自我介绍。
- 群聊记录里【角色名】开头的是各成员的发言,你自己的历史发言也在其中,不要重复已有内容,在其基础上推进。
- 记录过长时较早的发言会被折叠成「结构存根 + 前情纪要」;需要逐字引用被折叠的原文时,用 read_group_message 按存根标注的消息 id 取回,长文档按行区间分段读。
- 完成后在消息**末尾**决定下一棒:还需要谁接力就每人一行写「@角色名 一句话交代要做什么」,**可以 @ 多位,他们会同时开跑**;整条链路完成或需要用户决策时写「@用户 一句话总结」。

**什么时候可以交接、什么时候必须收口**

- 交接的理由只能是「有一件具体的、你做不了的事要别人做」。写不出这件具体的事,就是收口的时候。
- **只是"还可以再优化"不构成交接理由。** 优化建议是无限的,把它写进你自己文档的「后续可优化」小节,然后 @用户。
- 评审 / 验证 / 复核类的产出,末尾必须给**二元结论**:「结论:通过」或「结论:不通过」,后面跟**阻断性问题清单**(阻断 = 不改就没法继续往下做的问题,可以是 0 条)。
  - 0 条阻断性问题 → 必须 @用户 收口,不许因为"还有改进空间"再起一棒;
  - 有阻断性问题 → @ 能改的那位,并把问题逐条列清楚。
- 同一份交付物的返工最多一轮。第二次评审还不通过,把分歧点写清楚交给 @用户 定夺,不要继续在成员之间来回。`,
    mergeOf?.length ? mergeSection(mergeOf) : '',
    checklistSection(checklist),
    budget ? budgetSection(budget) : '',
    peers.length > 0
      ? `## 你不是一个人在跑

本轮和你**同时**开跑的还有:${peers.map((name) => `@${name}`).join('、')}。

- 你们是并行的,**看不到彼此本轮的产出**——群聊记录里只有已经完成的发言,他们此刻写的东西你现在读不到。
- 所以:只做你自己职责内的那部分,不要替他们把活干了,也不要假装引用他们"刚写的"内容。
- 确实需要他们的结果才能往下走,就在末尾 @ 对方并说清要什么;对方接棒时能看到你这篇文档。
- 你产出的东西如果和他们的可能冲突(同一张表、同一个接口),把你的假设明确写出来,让后面的人有据可依。`
      : '',
    hasRoots
      ? '- 用户授权了本地目录:先用 list_local / read_local_file 读里面的文档定位背景,再动笔。'
      : '- 用户没有授权本地目录,基于群聊内容做合理假设,并把关键假设写在文档开头。',
    catalog
  ].join('\n\n')
}

/** 可被停止打断的退避等待:用户点了停止,不该被重试计时器多卡几秒 */
function backoff(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms)
    function done(): void {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
    signal.addEventListener('abort', done)
  })
}

function resolveStoredMembers(members: SessionSettings['members']): GroupMember[] {
  return isConfiguredGroupMembers(members) ? members : []
}

function memberMention(member: GroupMember): { id: string; name: string } {
  return { id: member.id, name: member.name }
}
