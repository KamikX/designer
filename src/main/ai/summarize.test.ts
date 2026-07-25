import { describe, expect, it, vi } from 'vitest'
import {
  buildChunkPrompt,
  chunkText,
  DESIGN_SUMMARY_PROMPT,
  summarizeForDesign,
  SUMMARIZE_THRESHOLD
} from './summarize'

/**
 * 提炼这件事最怕的不是压得不够狠,是**把具体值压没了**。
 * "响应时间 < 200ms" 变成 "性能要求高",这份文档就白读了。
 * 所以 prompt 里那几条硬要求要钉住——它是这个功能唯一的质量抓手。
 */

describe('分块', () => {
  it('短文本不分块', () => {
    expect(chunkText('一段话', 100)).toEqual(['一段话'])
  })

  it('空文本给空数组,不产生一次空调用', () => {
    expect(chunkText('   ')).toEqual([])
  })

  it('优先在空行处断开,不切碎段落', () => {
    const text = `${'甲'.repeat(60)}\n\n${'乙'.repeat(60)}`
    const chunks = chunkText(text, 80)
    expect(chunks).toHaveLength(2)
    expect(chunks[0]).toBe('甲'.repeat(60))
    expect(chunks[1]).toBe('乙'.repeat(60))
  })

  it('没有空行时退回在换行处断', () => {
    const text = `${'甲'.repeat(60)}\n${'乙'.repeat(60)}`
    const chunks = chunkText(text, 80)
    expect(chunks[0]).toBe('甲'.repeat(60))
  })

  it('完全没有换行只能硬切,但不会丢内容', () => {
    const text = '字'.repeat(250)
    const chunks = chunkText(text, 100)
    expect(chunks.join('')).toHaveLength(250)
  })

  it('块数有上限,不会因为文档超长无限烧钱', () => {
    expect(chunkText('字'.repeat(500_000), 1000).length).toBeLessThanOrEqual(6)
  })
})

describe('prompt', () => {
  it('把"保留具体值"写死在系统提示里', () => {
    expect(DESIGN_SUMMARY_PROMPT).toContain('200ms')
    expect(DESIGN_SUMMARY_PROMPT).toContain('#1677ff')
    expect(DESIGN_SUMMARY_PROMPT).toContain('原样保留')
  })

  it('点名设计真正要用的东西,而不是笼统的"摘要"', () => {
    for (const section of ['页面', '数据与字段', '流程', '约束']) {
      expect(DESIGN_SUMMARY_PROMPT).toContain(section)
    }
  })

  it('多块时告诉模型自己在第几块', () => {
    expect(buildChunkPrompt('正文', 1, 3)).toContain('第 2 / 3 部分')
  })

  it('单块时不写位置,省得干扰', () => {
    expect(buildChunkPrompt('正文', 0, 1)).not.toContain('部分')
  })

  it('把用户这轮的诉求带进去——同一份文档问首页和问设置页该留的东西不同', () => {
    expect(buildChunkPrompt('正文', 0, 1, '做一个数据看板首页')).toContain('数据看板首页')
  })

  it('没有诉求时不留空占位', () => {
    expect(buildChunkPrompt('正文', 0, 1, '  ')).not.toContain('设计师关心的是')
  })
})

describe('提炼', () => {
  it('逐块调用,结果按顺序拼接并标出段号', async () => {
    const complete = vi.fn(async (_s: string, u: string) => `要点:${u.slice(-3)}`)
    const out = await summarizeForDesign(`${'甲'.repeat(60)}\n\n${'乙'.repeat(60)}`, complete)

    // 默认块大小很大,这段文本其实只有一块
    expect(complete).toHaveBeenCalledTimes(1)
    expect(out.chunks).toBe(1)
    expect(out.text).not.toContain('第 1 部分')
  })

  it('多块时标出段号,让主模型能把它们串起来', async () => {
    const complete = vi.fn(async () => '要点')
    const out = await summarizeForDesign('字'.repeat(50_000), complete)

    expect(out.chunks).toBeGreaterThan(1)
    expect(out.text).toContain('第 1 部分')
    expect(complete).toHaveBeenCalledTimes(out.chunks)
  })

  it('每次调用都带上同一份系统提示', async () => {
    const complete = vi.fn(async () => '要点')
    await summarizeForDesign('字'.repeat(50_000), complete)
    for (const [system] of complete.mock.calls as unknown as [string, string][]) {
      expect(system).toBe(DESIGN_SUMMARY_PROMPT)
    }
  })

  it('空文档不触发任何调用', async () => {
    const complete = vi.fn(async () => '要点')
    const out = await summarizeForDesign('   ', complete)
    expect(complete).not.toHaveBeenCalled()
    expect(out.chunks).toBe(0)
  })
})

describe('阈值', () => {
  it('阈值要明显大于一屏内容,小文档不该被绕这一圈', () => {
    expect(SUMMARIZE_THRESHOLD).toBeGreaterThan(2000)
  })
})
