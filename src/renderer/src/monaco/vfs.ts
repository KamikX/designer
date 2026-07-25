import { monaco } from './setup'

/**
 * 渲染侧的 model 池——主进程 SessionVfs 的镜像。
 *
 * 一个文件一个 ITextModel,切文件只换 editor.setModel(),不重建编辑器:
 * 滚动位置、折叠状态、以及增量 patch 打进来的历史都能保住。
 *
 * 真值在主进程(见 src/main/ai/session-vfs.ts),这里只负责把变更就地
 * 打进视图。所有写入都走 pushEditOperations 而不是 setValue——后者会
 * 重建整个 model,滚动位置和光标全丢。
 */

const models = new Map<string, monaco.editor.ITextModel>()

const EXT_LANG: Record<string, string> = {
  html: 'html',
  htm: 'html',
  css: 'css',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  ts: 'typescript',
  mts: 'typescript',
  jsx: 'jsx',
  tsx: 'tsx',
  vue: 'vue',
  json: 'json',
  md: 'markdown'
}

function langOf(path: string): string {
  return EXT_LANG[path.split('.').pop()?.toLowerCase() ?? ''] ?? 'plaintext'
}

/**
 * 取(或建)某个文件的 model。
 *
 * content 是调用方(artifact store)手里的真值:若 model 已存在但内容
 * 对不上——比如这个文件在没被查看时收到过 patch——就地校正回来。
 */
export function getModel(path: string, content: string): monaco.editor.ITextModel {
  let model = models.get(path)
  if (!model || model.isDisposed()) {
    model = monaco.editor.createModel(content, langOf(path), monaco.Uri.parse(`vfs:///${path}`))
    models.set(path, model)
    return model
  }
  if (model.getValue() !== content) replaceAll(model, content)
  return model
}

/** 全量替换(流式增长 / 兜底纠偏),返回是否真的动了 */
export function setContent(path: string, content: string): boolean {
  const model = models.get(path)
  if (!model || model.isDisposed() || model.getValue() === content) return false
  replaceAll(model, content)
  return true
}

/**
 * 局部 patch:按锚点字符串定位后就地 applyEdits,返回改动覆盖的行区间
 * (供调用方滚动定位 + 闪一下高亮)。定位失败退回全量替换。
 */
export function applyPatch(
  path: string,
  oldText: string,
  newText: string,
  replaceAllOccurrences = false
): { startLine: number; endLine: number } | null {
  const model = models.get(path)
  if (!model || model.isDisposed()) return null

  // oldText 为空表示新建 / 整份重写,没有锚点可定位
  if (!oldText) {
    replaceAll(model, newText)
    return { startLine: 1, endLine: model.getLineCount() }
  }

  const hits = model.findMatches(
    oldText,
    false,
    false,
    true,
    null,
    false,
    replaceAllOccurrences ? 0 : 1
  )
  if (hits.length === 0) return null

  const edits = hits.map((hit) => ({ range: hit.range, text: newText }))
  model.pushEditOperations([], edits, () => null)

  const first = hits[0].range
  const newLineCount = newText.split('\n').length - 1
  return { startLine: first.startLineNumber, endLine: first.startLineNumber + newLineCount }
}

let scope = ''

/**
 * 声明当前 model 池属于哪个项目。换项目就整池清掉——不同项目撞同名
 * 路径(index.html 满地都是)时,旧 model 会串味。
 *
 * 同项目内切版本不清池:getModel 会按新内容自愈,滚动位置还能保住。
 */
export function setScope(next: string): void {
  if (scope === next) return
  scope = next
  disposeAll()
}

/** 清空整池 */
export function disposeAll(): void {
  for (const model of models.values()) model.dispose()
  models.clear()
}

function replaceAll(model: monaco.editor.ITextModel, content: string): void {
  model.pushEditOperations([], [{ range: model.getFullModelRange(), text: content }], () => null)
}
