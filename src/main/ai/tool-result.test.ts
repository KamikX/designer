import { describe, expect, it } from 'vitest'
import { AnchorError } from './anchor-registry'
import { StringEditError } from './string-edits'
import { classifyError, renderToolResult, toolError, toolOk } from './tool-result'
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
