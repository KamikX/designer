import { aiText } from '../i18n'
/** 单条路径的深度上限(从根一路接下去数几棒) */
export const MAX_HOPS = 8
/**
 * 整棵接力树的总棒数上限。
 *
 * 一条消息 @ 多位会 fan-out 成多条分支,每条分支还能再分叉。MAX_HOPS 只管
 * 单条路径的深度,管不住"三条分支各跑八棒"——总量得单独封顶,否则一次
 * 点名就能把二十几次模型调用打出去。
 */
export const MAX_TOTAL_HOPS = 16
/**
 * 同时在跑的棒数上限。
 *
 * 一次 @ 五个人就是五路并发请求打同一个供应商,中转站限流当场 429。
 * 超出的排队等空位——用户看到的是"先跑三个,空一个补一个",而不是一半报错。
 */
export const MAX_PARALLEL = 3
/**
 * 单条链里同一成员最多参与 3 次。
 *
 * 实测的正常协作节奏是"产出 → 评审 → 修正 → 复审":评审员在一条链里
 * 天然要出场两到三次。上限 2 会把最后的复审拦在门外,用户只能手动补一句
 * "继续评审"——3 次容得下一轮完整返工,又不至于放开无限拉扯。
 */
export const MAX_VISITS = 3
/**
 * 同一有向交接(A→B)最多走 2 次:第一次是正常移交,第二次是返工后的
 * 再移交;第三次说明两人已经开始绕圈,停下来交还给用户判断。
 */
export const MAX_EDGE_REPEATS = 2

export type GroupChainStopReason = 'cycle-detected' | 'member-limit' | 'hop-limit'

export type GroupChainGuardResult =
  { ok: true } | { ok: false; reason: GroupChainStopReason; message: string }

/**
 * 拦停不是终点:三种 reason 都是"有界循环"的边界,chain-stopped 事件会带上
 * 被拦的成员 id,渲染层给一键续棒——用户确认后以一条新消息开新链(guard
 * 计数随链重置),循环因此永远有人类检查点,而不是无限自转。
 *
 * ## 一条路径一个 guard
 *
 * 接力是树不是链:一棒可以 @ 多位,分出多条并行分支。guard 判的是"**这条
 * 路径**有没有在绕圈",所以分叉时每条子路径拿一份 fork() 出来的副本。共用
 * 同一个对象的话,previous 和 edge 会被兄弟分支互相串味——判出来的环是假的,
 * 而真正的自转反而漏判。
 *
 * @param total 整棵树共享的总棒数计数器。跨分支的量只能记在共享对象上
 */
export class GroupChainGuard {
  private readonly visits = new Map<string, number>()
  private readonly edges = new Map<string, number>()
  private previous: { id: string; name: string } | null = null
  private hops = 0
  private readonly total: { count: number }

  constructor(total: { count: number } = { count: 0 }) {
    this.total = total
  }

  /**
   * 当前预算,给提示词用。
   *
   * 这几个数以前只活在程序里,模型一个字都看不到——于是它没有任何依据判断
   * "该收尾了",@ 下一位永远是零成本的默认动作。把剩余棒数摆到它面前,
   * 收敛才有可能是模型自己做的决定,而不是被 guard 砍断。
   *
   * @param entering 是否把"即将开始的这一棒"算进去(在 enter 之前调用时传 true)
   */
  budget(entering = false): { hop: number; remaining: number; totalLimit: number } {
    const hop = this.hops + (entering ? 1 : 0)
    const used = this.total.count + (entering ? 1 : 0)
    return {
      hop,
      // 两道闸取更紧的那道:说出去的"还剩几棒"必须是真的还能跑几棒
      remaining: Math.max(0, Math.min(MAX_HOPS - hop, MAX_TOTAL_HOPS - used)),
      totalLimit: MAX_TOTAL_HOPS
    }
  }

  /** 分叉:子路径继承到此为止的历史,之后各走各的 */
  fork(): GroupChainGuard {
    const next = new GroupChainGuard(this.total)
    for (const [key, value] of this.visits) next.visits.set(key, value)
    for (const [key, value] of this.edges) next.edges.set(key, value)
    next.previous = this.previous
    next.hops = this.hops
    return next
  }

  /**
   * @param name 拦停文案里显示的成员名。这段话是用户唯一能看到的解释,
   * 必须回答"为什么停了、我接下来能做什么"——ULID 两个都答不了。
   */
  enter(memberId: string, name: string = memberId): GroupChainGuardResult {
    const visitCount = (this.visits.get(memberId) ?? 0) + 1
    if (visitCount > MAX_VISITS) {
      return {
        ok: false,
        reason: 'member-limit',
        message: aiText('ai.groupChain.hasParticipatedTimesTheRelayStopped', name, MAX_VISITS, name)
      }
    }

    const edge = this.previous == null ? null : `${this.previous.id}→${memberId}`
    if (edge != null && (this.edges.get(edge) ?? 0) >= MAX_EDGE_REPEATS) {
      return {
        ok: false,
        reason: 'cycle-detected',
        message: aiText(
          'ai.groupChain.theHandoffHasOccurredTimesTheRelayStoppedToAvoidALoop',
          this.previous?.name,
          name,
          MAX_EDGE_REPEATS
        )
      }
    }

    if (this.hops >= MAX_HOPS) {
      return {
        ok: false,
        reason: 'hop-limit',
        message: aiText(
          'ai.groupChain.thisRelayReachedItsTurnLimitAndStoppedMentionTheNextMember',
          MAX_HOPS
        )
      }
    }

    if (this.total.count >= MAX_TOTAL_HOPS) {
      return {
        ok: false,
        reason: 'hop-limit',
        message: aiText(
          'ai.groupChain.allBranchesTogetherReachedTheTurnLimitAndStoppedMentionTheNext',
          MAX_TOTAL_HOPS
        )
      }
    }

    this.visits.set(memberId, visitCount)
    if (edge != null) this.edges.set(edge, (this.edges.get(edge) ?? 0) + 1)
    this.previous = { id: memberId, name }
    this.hops++
    this.total.count++
    return { ok: true }
  }
}

/**
 * 一次 run 的并发调度:并发上限 + **同一成员串行**。
 *
 * 后者不是性能考虑而是正确性:两条分支同时点名同一个人时,如果真的并发跑,
 * 会同时落两条流式消息——transcript 的"每位成员最新一条"、折叠规则、纪要
 * 覆盖水位全部建立在"一个人一次说一句"上,同时两条直接把它们弄坏。
 * 排队等前一棒结束还有额外好处:后到的那棒能看到前一棒的产出。
 *
 * 纯内存,随一次 run 生死。
 */
export class HopScheduler {
  /** memberId → 该成员已排队任务的尾部,新任务接在它后面 */
  private readonly tails = new Map<string, Promise<unknown>>()
  private active = 0
  private readonly waiting: (() => void)[] = []

  constructor(private readonly limit: number = MAX_PARALLEL) {}

  /** 排到这个成员的队尾;返回 task 的结果(异常照常往外抛) */
  run<T>(memberId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(memberId) ?? Promise.resolve()
    // catch 挂在链上而不是 task 上:前一棒失败不该把后面排队的一起带走
    const next = previous.then(
      () => this.withSlot(task),
      () => this.withSlot(task)
    )
    this.tails.set(
      memberId,
      next.catch(() => undefined)
    )
    return next
  }

  private async withSlot<T>(task: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) {
      await new Promise<void>((resolve) => this.waiting.push(resolve))
    }
    this.active++
    try {
      return await task()
    } finally {
      this.active--
      this.waiting.shift()?.()
    }
  }
}
