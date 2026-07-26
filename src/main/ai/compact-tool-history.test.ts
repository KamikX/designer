import { modelMessageSchema } from 'ai'
import type { ModelMessage } from 'ai'
import { describe, expect, it } from 'vitest'
import { compactToolHistory, TOOL_LEDGER_TAG } from './compact-tool-history'
import type { CompactionContext } from './compact-tool-history'

/**
 * 历史压缩的合法形态测试:按 toolCallId 成对删除,保留并行的其他调用与
 * 普通文本,产出唯一可替换的 <tool_ledger>,每条消息都过 modelMessageSchema。
 */

const BIG_CONTENT = 'x'.repeat(5000)

function toolCall(id: string, toolName: string, input: unknown): ModelMessage {
  return { role: 'assistant', content: [{ type: 'tool-call', toolCallId: id, toolName, input }] }
}

function toolResult(id: string, toolName: string, text: string): ModelMessage {
  return {
    role: 'tool',
    content: [
      { type: 'tool-result', toolCallId: id, toolName, output: { type: 'text', value: text } }
    ]
  }
}

function ctx(overrides: Partial<CompactionContext> = {}): CompactionContext {
  return {
    completedWrites: [],
    recentErrors: [],
    activatedSkills: new Set(),
    ...overrides
  }
}

function textOf(messages: ModelMessage[]): string {
  return JSON.stringify(messages)
}

describe('写工具压缩', () => {
  it('已完成的大体积写参数与结果按 callId 成对移除,事实进账本', () => {
    const messages: ModelMessage[] = [
      { role: 'user', content: '改一下首页' },
      toolCall('w1', 'write_file', { path: 'index.html', content: BIG_CONTENT }),
      toolResult('w1', 'write_file', '已写入 index.html')
    ]
    const out = compactToolHistory(
      messages,
      ctx({
        completedWrites: [{ path: 'index.html', revision: 1, tool: 'write_file', chars: 5000 }]
      })
    )
    expect(textOf(out)).not.toContain(BIG_CONTENT)
    const ledger = out.find(
      (m) =>
        m.role === 'user' && typeof m.content === 'string' && m.content.includes(TOOL_LEDGER_TAG)
    )
    expect(ledger).toBeDefined()
    expect(String(ledger!.content)).toContain('index.html')
    // 调用与结果成对消失,不留孤儿
    expect(textOf(out)).not.toContain('"toolCallId":"w1"')
  })

  it('失败的写调用同样压缩,错误事实保留在账本里', () => {
    const messages: ModelMessage[] = [
      { role: 'user', content: '改' },
      toolCall('e1', 'edit_file', { path: 'a.vue', old_string: BIG_CONTENT, new_string: 'x' }),
      toolResult('e1', 'edit_file', '错误:未找到匹配内容。\n[code: MATCH_NOT_FOUND]')
    ]
    const out = compactToolHistory(
      messages,
      ctx({
        recentErrors: [{ tool: 'edit_file', code: 'MATCH_NOT_FOUND', path: 'a.vue' }]
      })
    )
    expect(textOf(out)).not.toContain(BIG_CONTENT)
    const ledger = String(out.at(-1)!.content)
    expect(ledger).toContain('MATCH_NOT_FOUND')
  })
})

describe('过期读结果', () => {
  it('文件后来被改过的 read/search/capture 结果被移除', () => {
    const messages: ModelMessage[] = [
      { role: 'user', content: '改' },
      toolCall('r1', 'read_file', { path: 'a.vue' }),
      toolResult('r1', 'read_file', `1→${BIG_CONTENT}`),
      toolCall('w1', 'edit_file', { path: 'a.vue', old_string: 'x', new_string: 'y' }),
      toolResult('w1', 'edit_file', '已编辑 a.vue')
    ]
    const out = compactToolHistory(messages, ctx())
    expect(textOf(out)).not.toContain(BIG_CONTENT)
  })

  it('没被后续写动过的读结果保留(下一步还要用)', () => {
    const messages: ModelMessage[] = [
      { role: 'user', content: '改' },
      toolCall('r1', 'read_file', { path: 'b.vue' }),
      toolResult('r1', 'read_file', '1→const keep = true'),
      toolCall('w1', 'edit_file', { path: 'a.vue', old_string: 'x', new_string: 'y' }),
      toolResult('w1', 'edit_file', '已编辑 a.vue')
    ]
    const out = compactToolHistory(messages, ctx())
    expect(textOf(out)).toContain('const keep = true')
  })
})

describe('技能激活', () => {
  it('首个技能正文保留一份,重复激活替换为账本短事实', () => {
    const body = `# craft-admin 技能正文 ${'规'.repeat(2000)}`
    const messages: ModelMessage[] = [
      { role: 'user', content: '开始' },
      toolCall('s1', 'activate_skill', { name: 'craft-admin' }),
      toolResult('s1', 'activate_skill', body),
      { role: 'assistant', content: [{ type: 'text', text: '看完了' }] },
      toolCall('s2', 'activate_skill', { name: 'craft-admin' }),
      toolResult('s2', 'activate_skill', body)
    ]
    const out = compactToolHistory(messages, ctx({ activatedSkills: new Set(['craft-admin']) }))
    const text = textOf(out)
    // 第一份正文还在,第二份没了
    expect(text.split('craft-admin 技能正文')).toHaveLength(2)
    expect(text).not.toContain('"toolCallId":"s2"')
    expect(String(out.at(-1)!.content)).toContain('craft-admin')
  })
})

describe('消息合法性', () => {
  it('混合文本 + 并行调用:只摘掉被选中的 part,其余保留', () => {
    const messages: ModelMessage[] = [
      { role: 'user', content: '改' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: '我并行做两件事' },
          {
            type: 'tool-call',
            toolCallId: 'w1',
            toolName: 'write_file',
            input: { path: 'a.css', content: BIG_CONTENT }
          },
          { type: 'tool-call', toolCallId: 'r1', toolName: 'read_file', input: { path: 'b.vue' } }
        ]
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'w1',
            toolName: 'write_file',
            output: { type: 'text', value: '已写入 a.css' }
          },
          {
            type: 'tool-result',
            toolCallId: 'r1',
            toolName: 'read_file',
            output: { type: 'text', value: '1→保留我' }
          }
        ]
      }
    ]
    const out = compactToolHistory(messages, ctx())
    const text = textOf(out)
    expect(text).not.toContain(BIG_CONTENT)
    expect(text).toContain('我并行做两件事')
    expect(text).toContain('保留我')
    for (const message of out) modelMessageSchema.parse(message)
  })

  it('过滤后为空的 assistant/tool 消息被移除', () => {
    const messages: ModelMessage[] = [
      { role: 'user', content: '改' },
      toolCall('w1', 'write_file', { path: 'a.css', content: BIG_CONTENT }),
      toolResult('w1', 'write_file', '已写入 a.css')
    ]
    const out = compactToolHistory(messages, ctx())
    expect(out.filter((m) => m.role === 'assistant')).toHaveLength(0)
    expect(out.filter((m) => m.role === 'tool')).toHaveLength(0)
  })

  it('账本唯一且幂等:再压一次不重复追加', () => {
    const messages: ModelMessage[] = [
      { role: 'user', content: '改' },
      toolCall('w1', 'write_file', { path: 'a.css', content: BIG_CONTENT }),
      toolResult('w1', 'write_file', '已写入 a.css')
    ]
    const once = compactToolHistory(
      messages,
      ctx({
        completedWrites: [{ path: 'a.css', revision: 1, tool: 'write_file', chars: 5000 }]
      })
    )
    const twice = compactToolHistory(
      once,
      ctx({
        completedWrites: [
          { path: 'a.css', revision: 1, tool: 'write_file', chars: 5000 },
          { path: 'b.css', revision: 1, tool: 'write_file', chars: 10 }
        ]
      })
    )
    const ledgers = twice.filter(
      (m) =>
        m.role === 'user' && typeof m.content === 'string' && m.content.includes(TOOL_LEDGER_TAG)
    )
    expect(ledgers).toHaveLength(1)
    expect(String(ledgers[0].content)).toContain('b.css')
  })

  it('输入不被原地修改', () => {
    const messages: ModelMessage[] = [
      { role: 'user', content: '改' },
      toolCall('w1', 'write_file', { path: 'a.css', content: BIG_CONTENT }),
      toolResult('w1', 'write_file', '已写入 a.css')
    ]
    const snapshot = JSON.stringify(messages)
    compactToolHistory(messages, ctx())
    expect(JSON.stringify(messages)).toBe(snapshot)
  })

  it('全部输出消息通过 modelMessageSchema', () => {
    const messages: ModelMessage[] = [
      { role: 'system', content: '你是设计师' },
      { role: 'user', content: '改' },
      {
        role: 'assistant',
        content: [
          { type: 'reasoning', text: '想一想' },
          { type: 'text', text: '好的' },
          {
            type: 'tool-call',
            toolCallId: 'w1',
            toolName: 'write_file',
            input: { path: 'a.css', content: BIG_CONTENT }
          }
        ]
      },
      toolResult('w1', 'write_file', '已写入 a.css')
    ]
    const out = compactToolHistory(
      messages,
      ctx({
        completedWrites: [{ path: 'a.css', revision: 1, tool: 'write_file', chars: 5000 }]
      })
    )
    for (const message of out) modelMessageSchema.parse(message)
    // 普通文本与 reasoning 原样保留
    expect(textOf(out)).toContain('想一想')
    expect(textOf(out)).toContain('好的')
  })
})

describe('账本自身的体量', () => {
  it('写入/失败记录只保留最近若干条,更早的折叠成计数', () => {
    const messages: ModelMessage[] = [{ role: 'user', content: '改' }]
    const out = compactToolHistory(
      messages,
      ctx({
        completedWrites: Array.from({ length: 30 }, (_, i) => ({
          path: `f${i}.css`,
          revision: 1,
          tool: 'write_file',
          chars: 10
        })),
        recentErrors: Array.from({ length: 15 }, (_, i) => ({
          tool: 'edit_file',
          code: 'MATCH_NOT_FOUND' as const,
          path: `f${i}.css`
        }))
      })
    )
    const ledger = String(out.at(-1)!.content)
    // 最新的在,最早的被折叠
    expect(ledger).toContain('f29.css')
    expect(ledger).not.toContain('- 已完成写入:f0.css')
    expect(ledger).toContain('更早')
  })
})
