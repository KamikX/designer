import { describe, expect, it } from 'vitest'
import { GroupChainGuard, MAX_HOPS } from './group-chain'

describe('GroupChainGuard', () => {
  it('允许 A → B → A 的一次返工', () => {
    const guard = new GroupChainGuard()

    expect(guard.enter('A')).toEqual({ ok: true })
    expect(guard.enter('B')).toEqual({ ok: true })
    expect(guard.enter('A')).toEqual({ ok: true })
  })

  it('同一成员第三次参与时返回 member-limit', () => {
    const guard = new GroupChainGuard()
    for (const memberId of ['A', 'B', 'A', 'C']) {
      expect(guard.enter(memberId)).toEqual({ ok: true })
    }

    const result = guard.enter('A')
    expect(result).toMatchObject({ ok: false, reason: 'member-limit' })
    if (!result.ok) expect(result.message).toMatch(/成员.*两次/)
  })

  it('同一有向边第二次出现时返回 cycle-detected', () => {
    const guard = new GroupChainGuard()
    for (const memberId of ['A', 'B', 'C', 'A']) {
      expect(guard.enter(memberId)).toEqual({ ok: true })
    }

    const result = guard.enter('B')
    expect(result).toMatchObject({ ok: false, reason: 'cycle-detected' })
    if (!result.ok) expect(result.message).toMatch(/重复.*接力/)
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
