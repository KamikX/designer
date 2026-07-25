// monaco 0.56 的 exports 是 './*' → './esm/vs/*.js',所以路径里不写 esm/vs
import * as monaco from 'monaco-editor/editor/editor.api'
import EditorWorker from 'monaco-editor/editor/editor.worker?worker'

// 只读查看器需要的少数几个 contrib(editor.api 本身是光秃秃的内核)
import 'monaco-editor/editor/contrib/find/browser/findController'
import 'monaco-editor/editor/contrib/folding/browser/folding'
import 'monaco-editor/editor/contrib/bracketMatching/browser/bracketMatching'

/**
 * Monaco 运行环境。
 *
 * **不要从 'monaco-editor' 根入口导入**。它等于 editor.main,会把内置的
 * 几十种 Monarch 语言和 ts / css / html / json 语言服务一起拉进来:
 * 一是白扛几 MB,二是这些语言在建 model 时会按 label 去要各自的 worker,
 * 而我们只提供 editor.worker——协议对不上,直接报错。
 *
 * 这里只取内核 editor.api,语法高亮全部交给 Shiki(见 ./highlighter),
 * 语言 id 也由我们自己 register。Monaco 只当渲染器。
 */
self.MonacoEnvironment = { getWorker: () => new EditorWorker() }

export { monaco }
