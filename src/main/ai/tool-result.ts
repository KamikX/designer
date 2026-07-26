import { AnchorError } from './anchor-registry'
import { StringEditError } from './string-edits'
import { VfsError } from './vfs-error'

/**
 * 工具结果的结构化契约。
 *
 * 工具最终交给模型的仍然是文本(renderToolResult),但错误在内部先成为
 * 带码的结构——RunContextLedger 靠 code 做熔断统计,遥测靠它落库,
 * 模型靠文本里的 [code: X] 与恢复动作决定下一步。渲染保持「错误:」前缀,
 * 既有的 summarize / 活动条判定不用改。
 */

export type ToolErrorCode =
  | 'ANCHOR_STALE'
  | 'ANCHOR_NOT_FOUND'
  | 'RANGE_OVERLAP'
  | 'MATCH_NOT_FOUND'
  | 'MATCH_AMBIGUOUS'
  | 'PATCH_FORMAT_INVALID'
  | 'FILE_NOT_FOUND'
  | 'FILE_ALREADY_EXISTS'
  | 'INVALID_PATH'
  | 'SYNTAX_CHECK_FAILED'
  | 'TOOL_EXECUTION_FAILED'
  | 'TOOL_BUDGET_EXCEEDED'

export interface ToolRecovery {
  nextTool: string
  reason: string
}

export interface ToolResult {
  ok: boolean
  code?: ToolErrorCode
  message: string
  recovery?: ToolRecovery
  affectedFiles?: string[]
}

export function toolOk(message: string, affectedFiles?: string[]): ToolResult {
  return { ok: true, message, ...(affectedFiles ? { affectedFiles } : {}) }
}

export function toolError(
  code: ToolErrorCode,
  message: string,
  recovery?: ToolRecovery
): ToolResult {
  return { ok: false, code, message, ...(recovery ? { recovery } : {}) }
}

/** 锚点编辑是截断行/复述失败的标准出路,恢复建议统一指向它 */
export const ANCHORED_EDIT_RECOVERY: ToolRecovery = {
  nextTool: 'capture_range + apply_string_edits',
  reason: '让服务端持有精确区间,不再复述可能被截断的原文'
}

/**
 * VfsError 的文案 → 规格错误码。
 * 文案是给模型的指引、由本仓库自己维护,按开头短语归类足够稳定;
 * 未识别的一律 TOOL_EXECUTION_FAILED,宁可码粗一点也不误判。
 */
const VFS_MESSAGE_RULES: [RegExp, ToolErrorCode][] = [
  [/^未找到匹配内容/, 'MATCH_NOT_FOUND'],
  [/^匹配到 \d+ 处/, 'MATCH_AMBIGUOUS'],
  [/^第 \d+ 处编辑失败/, 'MATCH_NOT_FOUND'],
  [/^文件不存在/, 'FILE_NOT_FOUND'],
  [/已存在/, 'FILE_ALREADY_EXISTS'],
  [/^路径|^起始行|^结束行|盘符|不能为空。$/, 'INVALID_PATH'],
  [/补丁|Begin Patch|End Patch|hunk|定位不到|必须以空格/, 'PATCH_FORMAT_INVALID']
]

export function classifyError(err: unknown): ToolResult {
  if (err instanceof AnchorError) {
    return toolError(err.code === 'INVALID_RANGE' ? 'INVALID_PATH' : err.code, err.message)
  }
  if (err instanceof StringEditError) {
    return toolError(
      err.code === 'RANGE_OVERLAP' ? 'RANGE_OVERLAP' : 'TOOL_EXECUTION_FAILED',
      err.message
    )
  }
  if (err instanceof VfsError) {
    for (const [pattern, code] of VFS_MESSAGE_RULES) {
      if (pattern.test(err.message)) {
        return toolError(
          code,
          err.message,
          // 锚点没对上的失败,第一时间就把出路指出来
          code === 'MATCH_NOT_FOUND' || code === 'MATCH_AMBIGUOUS'
            ? ANCHORED_EDIT_RECOVERY
            : undefined
        )
      }
    }
    return toolError('TOOL_EXECUTION_FAILED', err.message)
  }
  // 非预期异常:原始 message 可能含敏感内容,给模型固定文案(遥测另有脱敏)
  return toolError('TOOL_EXECUTION_FAILED', '工具执行失败,请换一种方式重试。')
}

/** 结构化结果 → 给模型的文本。失败保持「错误:」前缀 */
export function renderToolResult(result: ToolResult): string {
  if (result.ok) return result.message
  const lines = [`错误:${result.message}`]
  if (result.code) lines.push(`[code: ${result.code}]`)
  if (result.recovery)
    lines.push(`下一步:用 ${result.recovery.nextTool}(${result.recovery.reason})。`)
  return lines.join('\n')
}
