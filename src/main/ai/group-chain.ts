export const MAX_HOPS = 8
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
 */
export class GroupChainGuard {
  private readonly visits = new Map<string, number>()
  private readonly edges = new Map<string, number>()
  private previous: { id: string; name: string } | null = null
  private hops = 0

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
        message: `「${name}」已参与 ${MAX_VISITS} 次，为避免无限返工，接力已自动停止。还需要 TA 继续的话，再发一条 @${name} 即可。`
      }
    }

    const edge = this.previous == null ? null : `${this.previous.id}→${memberId}`
    if (edge != null && (this.edges.get(edge) ?? 0) >= MAX_EDGE_REPEATS) {
      return {
        ok: false,
        reason: 'cycle-detected',
        message: `「${this.previous?.name} → ${name}」这条交接已经走过 ${MAX_EDGE_REPEATS} 次，继续更像是在绕圈，接力已自动停止。需要继续的话，手动 @ 下一位成员即可。`
      }
    }

    if (this.hops >= MAX_HOPS) {
      return {
        ok: false,
        reason: 'hop-limit',
        message: `接力已达 ${MAX_HOPS} 棒上限，已自动停止。需要继续的话，手动 @ 下一位成员即可。`
      }
    }

    this.visits.set(memberId, visitCount)
    if (edge != null) this.edges.set(edge, (this.edges.get(edge) ?? 0) + 1)
    this.previous = { id: memberId, name }
    this.hops++
    return { ok: true }
  }
}
