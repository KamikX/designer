import { streamText } from 'ai'
import { MockLanguageModelV3, simulateReadableStream } from 'ai/test'
import { describe, expect, it } from 'vitest'
import { compactToolHistory } from './compact-tool-history'
import { RunContextLedger } from './run-context-ledger'
import { SessionVfs } from './session-vfs'
import { buildFileTools } from './tools'

/**
 * 假多步模型的集成测试:第一步读 + 写同一个文件,第二步请求发出前
 * prepareStep 用 compactToolHistory 改写历史。断言第二步的序列化请求里
 * 大补丁与过期读取消失、成功写入事实与继续工作所需的上下文仍在,
 * 且请求体积显著变小。
 */

type V3StreamResult = Awaited<ReturnType<InstanceType<typeof MockLanguageModelV3>['doStream']>>
type V3StreamPart = V3StreamResult['stream'] extends ReadableStream<infer P> ? P : never

const BIG = `.hero{${'padding:1px;'.repeat(500)}}`

const USAGE = {
  inputTokens: { total: 100, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 10, text: 10, reasoning: undefined }
}

describe('多步压缩集成', () => {
  it('第二步请求不含大补丁与过期读取,且体积更小', async () => {
    const vfs = new SessionVfs([{ path: 'a.css', content: '.hero { color: red; }\n' }])
    const ledger = new RunContextLedger()
    const tools = buildFileTools(vfs, { onPatch: () => {}, onDelete: () => {} }, { ledger })

    const prompts: string[] = []
    let call = 0
    const model = new MockLanguageModelV3({
      doStream: async (options) => {
        prompts.push(JSON.stringify(options.prompt))
        call += 1
        const chunks: V3StreamPart[] =
          call === 1
            ? [
                { type: 'stream-start', warnings: [] },
                {
                  type: 'tool-call',
                  toolCallId: 'r1',
                  toolName: 'read_file',
                  input: JSON.stringify({ path: 'a.css' })
                },
                {
                  type: 'tool-call',
                  toolCallId: 'w1',
                  toolName: 'write_file',
                  input: JSON.stringify({ path: 'a.css', content: BIG })
                },
                {
                  type: 'finish',
                  finishReason: { unified: 'tool-calls' as const, raw: 'tool_calls' },
                  usage: USAGE
                }
              ]
            : [
                { type: 'stream-start', warnings: [] },
                { type: 'text-start', id: '0' },
                { type: 'text-delta', id: '0', delta: '改完了' },
                { type: 'text-end', id: '0' },
                {
                  type: 'finish',
                  finishReason: { unified: 'stop' as const, raw: 'stop' },
                  usage: USAGE
                }
              ]
        return { stream: simulateReadableStream({ chunks }) }
      }
    })

    const result = streamText({
      model,
      tools,
      messages: [{ role: 'user', content: '把 hero 的内边距都改掉' }],
      prepareStep: ({ messages }) => ({
        messages: compactToolHistory(messages, {
          completedWrites: ledger.completedWrites,
          recentErrors: ledger.recentErrors,
          activatedSkills: ledger.activatedSkills
        })
      }),
      stopWhen: ({ steps }) => steps.length >= 3
    })
    for await (const part of result.fullStream) {
      if (part.type === 'error') throw part.error
    }

    expect(prompts).toHaveLength(2)
    const second = prompts[1]
    // 大补丁正文与过期的读结果都不在第二步请求里
    expect(second).not.toContain('padding:1px;padding:1px;')
    expect(second).not.toContain('color: red')
    // 成功写入的事实(账本)在,模型知道自己已经改完了 a.css
    expect(second).toContain('tool_ledger')
    expect(second).toContain('a.css')
    // 体积显著缩小
    expect(second.length).toBeLessThan(prompts[0].length + BIG.length / 2)
    // 写真的发生了
    expect(vfs.raw('a.css').content).toBe(BIG)
  })
})
