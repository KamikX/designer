import type { PreviewLib, Stack } from '../../shared/types'

/**
 * 运行中设计会话的预览源注册表。
 *
 * preview://artifact/* 只认**已落库**的版本,而截图自审要看的是模型此刻还在
 * VFS 里改的东西——落库要等收尾。这里挂一个按 sessionId 索引的活动快照源,
 * 协议层多认一个 host(preview://session/<id>/...)就能把同一套编译直出复用到
 * 未落库的内容上。
 *
 * 生命周期由 chat-service 管:开流注册、收流(finally)注销。进程内存即可——
 * 它是纯过程态,断电即弃。
 */
export interface SessionPreviewSource {
  stack: Stack
  libs: PreviewLib[]
  /** 每次请求现取:截图发生在模型连续编辑之间,快照一定要是最新的 */
  files: () => { path: string; content: string }[]
}

const sessions = new Map<string, SessionPreviewSource>()

export function registerSessionPreview(id: string, source: SessionPreviewSource): void {
  sessions.set(id, source)
}

export function unregisterSessionPreview(id: string): void {
  sessions.delete(id)
}

export function getSessionPreview(id: string): SessionPreviewSource | null {
  return sessions.get(id) ?? null
}
