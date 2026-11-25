import type { ToolErrorCode } from './tool-result'

/**
 * 面向模型的错误。
 *
 * message 本身就是给模型看的指引,由 tools 层当作工具结果返回而不是抛
 * 出去——抛异常会中断 streamText 循环,返回错误文本则让模型看见并自己
 * 纠正。所以文案要说清"下一步该干什么",不要只说"失败了"。
 *
 * 单独成文件是为了让 session-vfs / patch-format 都能用它而不互相 import。
 */
export class VfsError extends Error {
  constructor(
    message: string,
    readonly code?: ToolErrorCode
  ) {
    super(message)
    this.name = 'VfsError'
  }
}
