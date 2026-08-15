/**
 * 预览运行时错误的回流。
 *
 * ## 为什么必须有
 *
 * 在这之前,模型写完代码就结束了——它**完全不知道自己生成的东西跑不跑得
 * 起来**。用户看到白屏,还得自己把控制台报错复制粘贴回对话里。这是整条
 * 链路上唯一一个没有闭合的环。
 *
 * 现在:iframe 里出错 → postMessage 给 PreviewPane → 立刻上报主进程 →
 * 下一轮 system prompt 里带上"上一版跑挂了,错误是什么"。模型于是能在
 * 下一句话里直接去修,而不是等用户描述"它白屏了"。
 *
 * ## 为什么存在主进程而不是渲染层
 *
 * 和 SessionVfs 同一个理由:错误要在**下一轮组装 prompt 时**取用,而那时
 * 用户可能已经切了页面、关了窗口。押在"窗口还开着且是同一个组件实例"上
 * 太脆。这里存的是每个项目最近一次错误,进程内存即可——它是过程信息,
 * 重启后没有意义,不值得进库。
 */

/** 错误信息截断长度:堆栈可能很长,但前几行就够定位 */
const MAX_ERROR_CHARS = 1200

interface PreviewError {
  message: string
  /** 出错时预览的是哪个版本,换版本后旧错误就不该再提了 */
  artifactId: string
  at: number
}

const lastError = new Map<string, PreviewError>()

export function reportPreviewError(projectId: string, artifactId: string, message: string): void {
  lastError.set(projectId, {
    message: message.slice(0, MAX_ERROR_CHARS),
    artifactId,
    at: Date.now()
  })
}

/**
 * 预览恢复正常(挂载完成且没再报错)时清掉。
 *
 * 带 artifactId 时只清**同版本**的错误:用户切回某个能跑的旧版本看一眼,
 * 不该把最新版本"跑不起来"这个事实从下一轮 prompt 里抹掉。
 */
export function clearPreviewError(projectId: string, artifactId?: string): void {
  if (artifactId === undefined) {
    lastError.delete(projectId)
    return
  }
  const hit = lastError.get(projectId)
  if (hit && hit.artifactId === artifactId) lastError.delete(projectId)
}

/**
 * 取出该项目待告知模型的错误。
 *
 * @param currentArtifactId 本轮的基线版本。只有错误来自这个版本才算数——
 *        用户切回旧版本看到的报错,不该让模型去改新版本
 */
export function pendingPreviewError(
  projectId: string,
  currentArtifactId: string | null
): string | null {
  const hit = lastError.get(projectId)
  if (!hit) return null
  if (currentArtifactId && hit.artifactId !== currentArtifactId) return null
  return hit.message
}

/** 组装进 system prompt 的一段 */
export function previewErrorPrompt(message: string | null): string {
  if (!message) return ''
  return `
## 上一版预览报错了

用户当前看到的设计稿**跑不起来**,运行时错误如下:

\`\`\`
${message}
\`\`\`

**优先修这个**,再谈别的改动。错误信息里的文件名和行号是编译后的位置,
不一定对得上源文件,用 search_files 按报错里的标识符去定位。
修完在解说里一句话说明原因,别让用户以为你没看见。
`.trim()
}
