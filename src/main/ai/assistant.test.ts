import { describe, expect, it, vi, beforeEach } from 'vitest'

/**
 * 这里只守一条底线,但它是这个功能里最重要的一条:
 * **提炼失败绝不能让读文档这件事失败**。
 *
 * 辅助模型没配、模型被删了、供应商挂了、密钥过期、返回空——任何一种都
 * 必须退回原文。为了省 token 而让主流程读不到文档,是本末倒置。
 *
 * config / db / registry 都要 mock 掉:前两个碰 better-sqlite3 与文件系统,
 * 后一个会真的去连供应商。
 */

const state = {
  assistantModel: null as { providerId: string; modelId: string } | null,
  modelRow: null as { modelId: string; displayName: string; enabled: boolean } | null,
  generate: vi.fn()
}

vi.mock('../config', () => ({ readConfig: () => ({ assistantModel: state.assistantModel }) }))
vi.mock('../db/repo/model', () => ({ getModel: () => state.modelRow }))
vi.mock('./registry', () => ({ getLanguageModel: () => ({}) as never }))
vi.mock('ai', () => ({ generateText: (...args: unknown[]) => state.generate(...args) }))

const { condenseIfLong, hasAssistantModel } = await import('./assistant')

const LONG = '这是一段很长的需求文档内容。'.repeat(1000)

beforeEach(() => {
  state.assistantModel = { providerId: 'p1', modelId: 'row1' }
  state.modelRow = { modelId: 'gpt-mini', displayName: '小模型', enabled: true }
  state.generate = vi.fn(async () => ({ text: '## 页面\n- 首页' }))
})

describe('短文档不绕这一圈', () => {
  it('低于阈值原样返回,不调模型', async () => {
    const out = await condenseIfLong('很短的一段话')
    expect(out.summarized).toBe(false)
    expect(out.text).toBe('很短的一段话')
    expect(out.note).toBe('')
    expect(state.generate).not.toHaveBeenCalled()
  })
})

describe('配置正常时提炼', () => {
  it('压成要点,并在 note 里说明是谁压的', async () => {
    const out = await condenseIfLong(LONG)
    expect(out.summarized).toBe(true)
    expect(out.text).toContain('## 页面')
    expect(out.note).toContain('小模型')
    expect(out.note).toContain('提炼')
  })

  it('把用户诉求带进去', async () => {
    await condenseIfLong(LONG, '做一个数据看板首页')
    const [[, user]] = state.generate.mock.calls.map((c) => [
      (c[0] as { system: string }).system,
      (c[0] as { messages: { content: string }[] }).messages[0].content
    ])
    expect(user).toContain('数据看板首页')
  })
})

describe('任何一种失败都退回原文', () => {
  it('没配辅助模型', async () => {
    state.assistantModel = null
    const out = await condenseIfLong(LONG)
    expect(out.summarized).toBe(false)
    expect(out.text).toBe(LONG)
    expect(out.note).toContain('还没配辅助模型')
    expect(hasAssistantModel()).toBe(false)
  })

  it('配了但模型行已被删除', async () => {
    state.modelRow = null
    const out = await condenseIfLong(LONG)
    expect(out.summarized).toBe(false)
    expect(out.text).toBe(LONG)
  })

  it('模型被停用', async () => {
    state.modelRow = { modelId: 'x', displayName: 'x', enabled: false }
    const out = await condenseIfLong(LONG)
    expect(out.summarized).toBe(false)
    expect(out.text).toBe(LONG)
  })

  it('调用抛错(密钥过期 / 供应商挂了)', async () => {
    state.generate = vi.fn(async () => {
      throw new Error('401 Unauthorized')
    })
    const out = await condenseIfLong(LONG)
    expect(out.summarized).toBe(false)
    expect(out.text).toBe(LONG)
    expect(out.note).toContain('401')
  })

  it('返回空内容也算失败', async () => {
    state.generate = vi.fn(async () => ({ text: '   ' }))
    const out = await condenseIfLong(LONG)
    expect(out.summarized).toBe(false)
    expect(out.text).toBe(LONG)
  })
})
