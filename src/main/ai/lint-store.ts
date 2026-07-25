import { renderLint } from './slop-lint'
import type { Finding } from './slop-lint'

/**
 * 上一版产物的检查结果。
 *
 * 和预览报错(preview/errors.ts)是同一套模式,包括那个关键的**按版本失效**:
 * 结果绑定在产生它的 artifactId 上,模型改完出新版本之后,旧结果自动作废。
 * 否则模型会对着一个已经修好的问题反复"修",越改越乱。
 *
 * 存内存不存库:它是过程信息,重启后没有意义。
 */
interface Entry {
  artifactId: string
  findings: Finding[]
}

const store = new Map<string, Entry>()

export function recordLint(projectId: string, artifactId: string, findings: Finding[]): void {
  store.set(projectId, { artifactId, findings })
}

/** @param currentArtifactId 本轮的基线版本。只有结果来自它才算数 */
export function pendingLint(projectId: string, currentArtifactId: string | null): string {
  const hit = store.get(projectId)
  if (!hit) return ''
  if (currentArtifactId && hit.artifactId !== currentArtifactId) return ''
  return renderLint(hit.findings)
}

export function clearLint(projectId: string): void {
  store.delete(projectId)
}
