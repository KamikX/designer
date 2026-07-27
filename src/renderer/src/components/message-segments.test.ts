import { describe, expect, it } from 'vitest'
import type { ToolActivity } from '@renderer/stores/chat'
import { splitMessageStream } from './message-segments'

/**
 * 切错了不会报错,只会让"哪句话之前调了哪个工具"对不上——一条消息读起来
 * 仍然像今天那样是一坨。这里钉住顺序、并行合组、以及缺字段时的退化行为。
 */

function tool(callId: string, afterChars?: number): ToolActivity {
  return {
    callId,
    toolName: 'read_file',
    label: `读 ${callId}`,
    state: 'success',
    ...(afterChars === undefined ? {} : { afterChars })
  }
}

describe('splitMessageStream', () => {
  it('没有工具就是一整段正文', () => {
    expect(splitMessageStream('只是解说', [])).toEqual([{ kind: 'text', text: '只是解说' }])
  })

  it('正文空、只有工具时不产出空文本段', () => {
    expect(splitMessageStream('', [tool('a', 0)])).toEqual([
      { kind: 'tools', activities: [tool('a', 0)] }
    ])
  })

  it('按发生位置把正文切开,交替成链', () => {
    const segments = splitMessageStream('先看看文件后面再说', [tool('a', 5)])
    expect(segments).toEqual([
      { kind: 'text', text: '先看看文件' },
      { kind: 'tools', activities: [tool('a', 5)] },
      { kind: 'text', text: '后面再说' }
    ])
  })

  it('同一位置的并行调用合成一组,交给折叠逻辑处理', () => {
    const segments = splitMessageStream('开始改', [tool('a', 3), tool('b', 3), tool('c', 3)])
    expect(segments).toHaveLength(2)
    expect(segments[1]).toMatchObject({ kind: 'tools' })
    expect(segments[1].kind === 'tools' && segments[1].activities.map((a) => a.callId)).toEqual([
      'a',
      'b',
      'c'
    ])
  })

  it('位置不同就各成一组,中间夹着那段正文', () => {
    const segments = splitMessageStream('一二三四五六', [tool('a', 2), tool('b', 4)])
    expect(segments.map((s) => s.kind)).toEqual(['text', 'tools', 'text', 'tools', 'text'])
    expect(segments[0]).toEqual({ kind: 'text', text: '一二' })
    expect(segments[2]).toEqual({ kind: 'text', text: '三四' })
    expect(segments[4]).toEqual({ kind: 'text', text: '五六' })
  })

  it('缺 afterChars 的(库里重新加载的老消息)一律排到末尾,退回今天的行为', () => {
    const segments = splitMessageStream('正文', [tool('a'), tool('b')])
    expect(segments[0]).toEqual({ kind: 'text', text: '正文' })
    expect(segments).toHaveLength(2)
    expect(segments[1].kind === 'tools' && segments[1].activities).toHaveLength(2)
  })

  it('位置回退或越界都被夹住,不会把正文切乱', () => {
    const segments = splitMessageStream('一二三', [tool('a', 2), tool('b', 1), tool('c', 999)])
    const text = segments.flatMap((s) => (s.kind === 'text' ? [s.text] : [])).join('')
    // 正文一个字不多一个字不少,顺序也没变
    expect(text).toBe('一二三')
  })
})
