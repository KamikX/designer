import { compilePreviewFile, isCompilable } from '../preview/compile'

/**
 * 编译探针:对单个产物文件跑一次**真编译**(与 preview:// 协议层同一个编译器),
 * 只取错误文本。
 *
 * 为什么需要它:check_syntax 只做括号/标签配对,而真正的编译在 iframe 请求模块时
 * 才会发生——那已经在版本落库**之后**,错误要等下一个用户回合才回流。探针把同一次
 * 编译前移到写入时和收尾时,让模型在当轮就拿到"这个文件跑不起来"的事实。
 *
 * 单文件即可编译:产物的 import 由浏览器按 ES 模块语义自行解析,编译器不爬依赖,
 * 所以孤立编译一个 .vue/.tsx 的结果与预览时完全一致。
 */
export function compileProbe(path: string, source: string): string | null {
  if (!isCompilable(path)) return null
  try {
    compilePreviewFile(path, source)
    return null
  } catch (err) {
    const text = err instanceof Error ? err.message : String(err)
    // 编译器的错误动辄整页 codeframe;给模型第一段就够定位,剩下的它自己会读文件
    const flat = text.trim()
    return flat.length > 600 ? `${flat.slice(0, 600)}…` : flat
  }
}
