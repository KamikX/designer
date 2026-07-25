/**
 * 模块路径解析:精确匹配 → 补后缀 → 目录 index。
 *
 * 浏览器的 ES import 必须精确到文件,而模型写的是 Node / 打包器习惯的
 * 无后缀导入(`import { useUsers } from '../useUsers'`,真实文件是
 * useUsers.ts)——这是训练出来的肌肉记忆,提示词层拦不干净。像打包器一样
 * 在"编译器"这一侧把路径补全,比在提示词里立规矩可靠得多。
 *
 * 独立成纯模块(不碰 electron):protocol.ts 顶层就要 app.getAppPath(),
 * 单测根本导入不了它。
 */

/**
 * 后缀顺序按主流打包器的惯例:脚本在前(ts 优先于 js),资源在后。
 * json 不在列表里——它没有走编译,裸 import 一个 json 在浏览器里本来就
 * 不合法,补全了也只是把错误往后挪。
 */
const RESOLVE_EXTS = ['.ts', '.tsx', '.js', '.jsx', '.vue', '.css']

export function resolveModuleFile<T extends { path: string }>(
  files: T[],
  request: string
): T | null {
  const exact = files.find((f) => f.path === request)
  if (exact) return exact
  /*
   * 带**已知后缀**却没命中,就是真的不存在,别再瞎补。
   * 但不能见点就当后缀:`import '../user.service'`(真实文件
   * user.service.ts)这种命名很常见,`.service` 不是后缀。
   */
  if (/\.(html|css|js|jsx|ts|tsx|vue|json|svg|png|jpe?g|gif|webp|ico|txt|md)$/i.test(request)) {
    return null
  }
  for (const ext of RESOLVE_EXTS) {
    const hit = files.find((f) => f.path === request + ext)
    if (hit) return hit
  }
  for (const ext of RESOLVE_EXTS) {
    const hit = files.find((f) => f.path === `${request}/index${ext}`)
    if (hit) return hit
  }
  return null
}
