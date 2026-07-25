export const MAX_HOPS = 8

export type GroupChainStopReason = 'cycle-detected' | 'member-limit' | 'hop-limit'

export type GroupChainGuardResult =
  { ok: true } | { ok: false; reason: GroupChainStopReason; message: string }

export class GroupChainGuard {
  private readonly visits = new Map<string, number>()
  private readonly edges = new Map<string, number>()
  private previousMemberId: string | null = null
  private hops = 0

  enter(memberId: string): GroupChainGuardResult {
    const visitCount = (this.visits.get(memberId) ?? 0) + 1
    if (visitCount > 2) {
      return {
        ok: false,
        reason: 'member-limit',
        message: `成员「${memberId}」已参与两次，为避免无限返工，接力已停止。`
      }
    }

    const edge = this.previousMemberId == null ? null : `${this.previousMemberId}→${memberId}`
    if (edge != null && (this.edges.get(edge) ?? 0) >= 1) {
      return {
        ok: false,
        reason: 'cycle-detected',
        message: `检测到重复接力 ${this.previousMemberId} → ${memberId}，为避免循环，接力已停止。`
      }
    }

    if (this.hops >= MAX_HOPS) {
      return {
        ok: false,
        reason: 'hop-limit',
        message: `接力已达到 ${MAX_HOPS} 棒上限，已停止。`
      }
    }

    this.visits.set(memberId, visitCount)
    if (edge != null) this.edges.set(edge, 1)
    this.previousMemberId = memberId
    this.hops++
    return { ok: true }
  }
}
