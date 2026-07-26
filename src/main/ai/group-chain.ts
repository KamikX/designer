export const MAX_HOPS = 8

export type GroupChainStopReason = 'cycle-detected' | 'member-limit' | 'hop-limit'

export type GroupChainGuardResult =
  { ok: true } | { ok: false; reason: GroupChainStopReason; message: string }

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
    if (visitCount > 2) {
      return {
        ok: false,
        reason: 'member-limit',
        message: `「${name}」已参与两次，为避免无限返工，接力已自动停止。还需要 TA 继续的话，再发一条 @${name} 即可。`
      }
    }

    const edge = this.previous == null ? null : `${this.previous.id}→${memberId}`
    if (edge != null && (this.edges.get(edge) ?? 0) >= 1) {
      return {
        ok: false,
        reason: 'cycle-detected',
        message: `「${this.previous?.name} → ${name}」这条交接已经走过一次，为避免循环，接力已自动停止。需要继续的话，手动 @ 下一位成员即可。`
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
    if (edge != null) this.edges.set(edge, 1)
    this.previous = { id: memberId, name }
    this.hops++
    return { ok: true }
  }
}
