import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { answerQuestion, buildAskUserTool, releaseQuestions, renderAnswer } from './ask-user'
import type { AskUserAnswer, AskUserInput } from '../../shared/types'

/**
 * 这里测的是"阻塞式提问"的收尾路径。工具会挂起等作答,所以每条路都要
 * 保证它一定会被放开——挂死意味着整个回合永远停在 streaming。
 */

const ASK: AskUserInput = {
  intro: '先确认方向',
  questions: [
    {
      header: '风格',
      question: '想要什么调性?',
      kind: 'single',
      options: [{ label: '极简' }, { label: '厚重' }]
    },
    {
      header: '配色',
      question: '偏好哪种?',
      kind: 'multiple',
      options: [{ label: '冷色' }, { label: '暖色' }],
      allowCustom: true
    }
  ],
  notes: { label: '补充' }
}

interface Harness {
  emitted: { questionId: string; ask: AskUserInput }[]
  answered: { questionId: string; answer: AskUserAnswer }[]
  abort: AbortController
  call: () => Promise<string>
}

function harness(streamId = 's1'): Harness {
  const emitted: Harness['emitted'] = []
  const answered: Harness['answered'] = []
  const abort = new AbortController()

  const tools = buildAskUserTool({
    streamId,
    signal: abort.signal,
    emit: (questionId, ask) => emitted.push({ questionId, ask }),
    onAnswered: (questionId, _ask, answer) => answered.push({ questionId, answer })
  })

  const call = async (): Promise<string> => {
    const out = await tools.ask_user.execute!(
      ASK as never,
      {
        toolCallId: 't',
        messages: []
      } as never
    )
    return String(out)
  }

  return { emitted, answered, abort, call }
}

/** 等 emit 发生(execute 里到 emit 之间只有同步代码 + 一个微任务) */
async function untilEmitted(h: Harness): Promise<string> {
  for (let i = 0; i < 20 && h.emitted.length === 0; i++) await Promise.resolve()
  expect(h.emitted).toHaveLength(1)
  return h.emitted[0].questionId
}

describe('ask_user 的收尾路径', () => {
  it('首次整体视觉方向确认的 purpose 会经 schema 保留', () => {
    const tools = buildAskUserTool({
      streamId: 'purpose',
      signal: new AbortController().signal,
      emit: () => {},
      onAnswered: () => {}
    })
    const parsed = (tools.ask_user.inputSchema as unknown as z.ZodType).safeParse({
      ...ASK,
      purpose: 'style-brief'
    })

    expect(parsed.success).toBe(true)
    if (parsed.success) expect(parsed.data).toMatchObject({ purpose: 'style-brief' })
  })

  it('正常作答:结果转成给模型看的文本,并回调存档', async () => {
    const h = harness()
    const pending = h.call()
    const id = await untilEmitted(h)

    expect(
      answerQuestion(id, { selections: [['极简'], ['冷色', '偏蓝紫']], notes: '首屏要大标题' })
    ).toBe(true)

    const result = await pending
    expect(result).toContain('- 风格:极简')
    expect(result).toContain('- 配色:冷色、偏蓝紫')
    expect(result).toContain('- 补充说明:首屏要大标题')
    expect(h.answered).toHaveLength(1)
  })

  it('用户跳过:明确告诉模型别再问', async () => {
    const h = harness()
    const pending = h.call()
    const id = await untilEmitted(h)

    answerQuestion(id, { selections: [], skipped: true })
    expect(await pending).toContain('不要再问一次')
  })

  it('中止时按跳过放开,不会挂死', async () => {
    const h = harness()
    const pending = h.call()
    await untilEmitted(h)

    h.abort.abort()
    expect(await pending).toContain('跳过')
  })

  it('已经中止了就不再发问,直接跳过', async () => {
    const h = harness()
    h.abort.abort()
    const result = await h.call()

    expect(h.emitted).toEqual([])
    expect(result).toContain('跳过')
  })

  it('releaseQuestions 收掉这条流上挂着的提问', async () => {
    const h = harness('s-release')
    const pending = h.call()
    await untilEmitted(h)

    releaseQuestions('s-release')
    expect(await pending).toContain('跳过')
  })

  it('releaseQuestions 不碰别的流', async () => {
    const h = harness('s-mine')
    const pending = h.call()
    const id = await untilEmitted(h)

    releaseQuestions('s-other')
    expect(answerQuestion(id, { selections: [['极简'], []] })).toBe(true)
    expect(await pending).toContain('- 风格:极简')
  })

  it('重复提交答案返回 false,不会二次 resolve', async () => {
    const h = harness()
    const pending = h.call()
    const id = await untilEmitted(h)

    expect(answerQuestion(id, { selections: [['极简'], []] })).toBe(true)
    expect(answerQuestion(id, { selections: [['厚重'], []] })).toBe(false)
    expect(await pending).toContain('极简')
  })

  it('不认识的 questionId 返回 false', () => {
    expect(answerQuestion('不存在', { selections: [] })).toBe(false)
  })
})

describe('renderAnswer', () => {
  it('没选的题如实标注', () => {
    expect(renderAnswer(ASK, { selections: [[], ['冷色']] })).toContain('- 风格:(未选)')
  })

  it('空补充说明不占一行', () => {
    expect(renderAnswer(ASK, { selections: [['极简'], []], notes: '   ' })).not.toContain(
      '补充说明'
    )
  })
})
