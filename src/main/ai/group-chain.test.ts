import { describe, expect, it } from 'vitest'
import {
  GroupChainGuard,
  HopScheduler,
  MAX_HOPS,
  MAX_PARALLEL,
  MAX_TOTAL_HOPS
} from './group-chain'

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

/**
 * 接力是树:一棒 @ 多位就分叉。guard 判的是"这条**路径**在不在绕圈",
 * 兄弟分支互相污染的话,判出来的环是假的、真自转反而漏判。
 */
describe('GroupChainGuard.fork:分叉后各走各的', () => {
  it('兄弟分支不共享 previous 与边计数', () => {
    const root = new GroupChainGuard()
    expect(root.enter('A')).toEqual({ ok: true })

    const left = root.fork()
    const right = root.fork()
    // 两边都从 A 出发走 A→B,各自都只是这条边的第一次
    expect(left.enter('B')).toEqual({ ok: true })
    expect(right.enter('B')).toEqual({ ok: true })
    expect(left.enter('A')).toEqual({ ok: true })
    expect(right.enter('A')).toEqual({ ok: true })
  })

  it('继承分叉点之前的历史:祖先走过的次数照算', () => {
    const root = new GroupChainGuard()
    for (const id of ['A', 'B', 'A']) expect(root.enter(id)).toEqual({ ok: true })

    // A 在分叉前已经参与 2 次,子路径里第 3 次仍放行,第 4 次才拦
    const branch = root.fork()
    expect(branch.enter('C')).toEqual({ ok: true })
    expect(branch.enter('A')).toEqual({ ok: true })
    expect(branch.enter('C')).toEqual({ ok: true })
    expect(branch.enter('A', '产品经理')).toMatchObject({ ok: false, reason: 'member-limit' })
  })

  it('总棒数跨分支共享:单条路径没超,合计超了照样拦', () => {
    const root = new GroupChainGuard()
    let entered = 0
    // 每条分支只走一棒,靠分支数量把总量堆满
    for (let index = 0; index < MAX_TOTAL_HOPS + 2; index++) {
      const branch = root.fork()
      if (branch.enter(`member-${index}`).ok) entered++
    }
    expect(entered).toBe(MAX_TOTAL_HOPS)

    const overflow = root.fork().enter('member-late')
    expect(overflow).toMatchObject({ ok: false, reason: 'hop-limit' })
    if (!overflow.ok) expect(overflow.message).toContain('全部分支合计')
  })
})

describe('HopScheduler', () => {
  /** 手动控制结束时机的任务,用来断言"谁在什么时候开始跑" */
  function deferred(): { promise: Promise<void>; resolve: () => void } {
    let resolve!: () => void
    const promise = new Promise<void>((r) => (resolve = r))
    return { promise, resolve }
  }

  it('同一成员串行:第二棒必须等第一棒结束才开始', async () => {
    const scheduler = new HopScheduler()
    const first = deferred()
    const started: string[] = []

    const a = scheduler.run('same', async () => {
      started.push('a')
      await first.promise
    })
    const b = scheduler.run('same', async () => {
      started.push('b')
    })

    await Promise.resolve()
    expect(started).toEqual(['a'])
    first.resolve()
    await Promise.all([a, b])
    expect(started).toEqual(['a', 'b'])
  })

  it('前一棒抛错不会卡住同一成员后面排队的棒', async () => {
    const scheduler = new HopScheduler()
    const failed = scheduler.run('same', async () => {
      throw new Error('上一棒挂了')
    })
    await expect(failed).rejects.toThrow('上一棒挂了')

    await expect(scheduler.run('same', async () => 'ok')).resolves.toBe('ok')
  })

  it('不同成员并发,但同时在跑的不超过上限', async () => {
    const scheduler = new HopScheduler()
    const gates = Array.from({ length: MAX_PARALLEL + 2 }, deferred)
    let active = 0
    let peak = 0

    const tasks = gates.map((gate, index) =>
      scheduler.run(`member-${index}`, async () => {
        active++
        peak = Math.max(peak, active)
        await gate.promise
        active--
      })
    )

    await Promise.resolve()
    expect(peak).toBe(MAX_PARALLEL)
    gates.forEach((gate) => gate.resolve())
    await Promise.all(tasks)
    expect(peak).toBe(MAX_PARALLEL)
  })
})
