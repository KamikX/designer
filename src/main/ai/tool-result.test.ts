import { modelMessageSchema } from 'ai'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { AnchorError } from './anchor-registry'
import { StringEditError } from './string-edits'
import {
  classifyError,
  contentAwareModelOutput,
  renderToolResult,
  toolError,
  toolOk
} from './tool-result'
import type { ContentToolOutput } from './tool-result'
import { VfsError } from './vfs-error'

describe('classifyError', () => {
  it('VfsError 按文案归类到规格错误码', () => {
    expect(classifyError(new VfsError('未找到匹配内容。请先 search_files……')).code).toBe(
      'MATCH_NOT_FOUND'
    )
    expect(classifyError(new VfsError('匹配到 3 处。请扩大 old_string……')).code).toBe(
      'MATCH_AMBIGUOUS'
    )
    expect(classifyError(new VfsError('文件不存在:a.css。')).code).toBe('FILE_NOT_FOUND')
    expect(classifyError(new VfsError('目标路径 b.css 已存在。')).code).toBe('FILE_ALREADY_EXISTS')
    expect(classifyError(new VfsError('路径不允许包含 .. 。')).code).toBe('INVALID_PATH')
    expect(classifyError(new VfsError('补丁必须以 *** Begin Patch 开头')).code).toBe(
      'PATCH_FORMAT_INVALID'
    )
    expect(classifyError(new VfsError('随便一种别的失败')).code).toBe('TOOL_EXECUTION_FAILED')
  })

  it('AnchorError / StringEditError 直接透传 code', () => {
    expect(classifyError(new AnchorError('ANCHOR_STALE', 'x')).code).toBe('ANCHOR_STALE')
    expect(classifyError(new AnchorError('ANCHOR_NOT_FOUND', 'x')).code).toBe('ANCHOR_NOT_FOUND')
    expect(classifyError(new StringEditError('RANGE_OVERLAP', 'x')).code).toBe('RANGE_OVERLAP')
  })

  it('MATCH_NOT_FOUND 自带切换锚点编辑的恢复建议', () => {
    const result = classifyError(new VfsError('未找到匹配内容。'))
    expect(result.recovery?.nextTool).toContain('capture_range')
  })
})

describe('renderToolResult', () => {
  it('成功渲染为纯消息', () => {
    expect(renderToolResult(toolOk('已编辑 a.css'))).toBe('已编辑 a.css')
  })

  it('失败保持「错误:」前缀,并附错误码与恢复动作', () => {
    const text = renderToolResult(
      toolError('MATCH_NOT_FOUND', '未找到匹配内容。', {
        nextTool: 'capture_range + apply_string_edits',
        reason: '避免复述被截断的原文'
      })
    )
    expect(text.startsWith('错误:')).toBe(true)
    expect(text).toContain('[code: MATCH_NOT_FOUND]')
    expect(text).toContain('capture_range')
  })
})

/**
 * 这一组钉的是**工具与 SDK 之间的契约**,而不是工具自己的返回形状。
 *
 * 曾经的 bug:view_image 直接从 execute 返回 `{type:'content', ...}`,以为 SDK
 * 会认出来。SDK 不认——没声明 toModelOutput 时非字符串一律包成
 * `{type:'json', value: 原样}`,里面的 Buffer 让消息过不了 ModelMessage 校验,
 * 而校验每个 step 都跑,于是"工具明明成功了,下一步却报 Invalid prompt"。
 *
 * 原来的测试只断言了 execute 的返回形状,所以完全看不见这个问题。判据必须是
 * **过一遍 modelMessageSchema**。
 */
describe('contentAwareModelOutput', () => {
  /** 复刻 ai 的 createToolModelOutput:没有 toModelOutput 时就是这两条路 */
  const asSdkWould = (
    output: unknown,
    toModelOutput?: (o: { output: unknown }) => unknown
  ): unknown =>
    toModelOutput
      ? toModelOutput({ output })
      : typeof output === 'string'
        ? { type: 'text', value: output }
        : { type: 'json', value: output ?? null }

  /** 工具结果最终会以这条 tool 消息的形态回到下一个 step 的请求里 */
  const validate = (output: unknown): boolean =>
    z.array(modelMessageSchema).safeParse([
      {
        role: 'tool',
        content: [{ type: 'tool-result', toolCallId: 't', toolName: 'view_image', output }]
      }
    ]).success

  const withImage: ContentToolOutput = {
    type: 'content',
    value: [
      { type: 'text', text: '参考图 a.png:' },
      { type: 'file', data: { type: 'data', data: Buffer.from([1, 2, 3]) }, mediaType: 'image/png' }
    ]
  }

  it('不挂 toModelOutput 时,带图的返回值会让下一个 step 的消息非法', () => {
    expect(validate(asSdkWould(withImage))).toBe(false)
  })

  it('挂上之后消息合法,图片以 content 块的形态交出去', () => {
    const output = asSdkWould(withImage, contentAwareModelOutput)
    expect(output).toMatchObject({ type: 'content' })
    expect(validate(output)).toBe(true)
  })

  it('字符串返回值仍走 text,不被包成 json', () => {
    const output = asSdkWould('读不出可用文字', contentAwareModelOutput)
    expect(output).toEqual({ type: 'text', value: '读不出可用文字' })
    expect(validate(output)).toBe(true)
  })
})
