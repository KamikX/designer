import { describe, expect, it } from 'vitest'
import { GroupChainGuard, MAX_HOPS } from './group-chain'

describe('GroupChainGuard', () => {
  it('允许 A → B → A 的一次返工', () => {
    const guard = new GroupChainGuard()

    expect(guard.enter('A')).toEqual({ ok: true })
    expect(guard.enter('B')).toEqual({ ok: true })
    expect(guard.enter('A')).toEqual({ ok: true })
  })

  it('允许一轮完整的评审循环:产出→评审→修正→复审(同边两次)', () => {
    const guard = new GroupChainGuard()
    for (const memberId of ['A', 'B', 'A', 'B']) {
      expect(guard.enter(memberId)).toEqual({ ok: true })
    }
  })

  it('同一成员第四次参与时返回 member-limit', () => {
    const guard = new GroupChainGuard()
    for (const memberId of ['A', 'B', 'A', 'C', 'A', 'B']) {
      expect(guard.enter(memberId)).toEqual({ ok: true })
    }

    const result = guard.enter('A', '产品经理')
    expect(result).toMatchObject({ ok: false, reason: 'member-limit' })
    // 文案要用成员名、并告诉用户怎么手动继续——ULID 对用户毫无意义
    if (!result.ok) {
      expect(result.message).toMatch(/「产品经理」.*3 次/)
      expect(result.message).toContain('@产品经理')
    }
  })

  it('同一有向边第三次出现时返回 cycle-detected', () => {
    const guard = new GroupChainGuard()
    for (const memberId of ['A', 'B', 'A', 'B', 'A']) {
      expect(guard.enter(memberId)).toEqual({ ok: true })
    }

    const result = guard.enter('B')
    expect(result).toMatchObject({ ok: false, reason: 'cycle-detected' })
    if (!result.ok) expect(result.message).toMatch(/走过 2 次.*绕圈/)
  })

  it('反向边不是重复边', () => {
    const guard = new GroupChainGuard()

    expect(guard.enter('A')).toEqual({ ok: true })
    expect(guard.enter('B')).toEqual({ ok: true })
    expect(guard.enter('A')).toEqual({ ok: true })
  })

  it('完成八棒后再进入成员时返回 hop-limit', () => {
    const guard = new GroupChainGuard()
    for (let index = 0; index < MAX_HOPS; index++) {
      expect(guard.enter(`member-${index}`)).toEqual({ ok: true })
    }

    const result = guard.enter('member-overflow')
    expect(result).toMatchObject({ ok: false, reason: 'hop-limit' })
    if (!result.ok) expect(result.message).toMatch(/8.*上限/)
  })
})
