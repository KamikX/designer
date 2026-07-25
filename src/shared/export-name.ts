/**
 * 导出目录名的唯一定义。
 *
 * 主进程按它建目录,渲染层的文件树按它显示根节点——两边必须是同一份
 * 规则,否则树上写着一套、落盘另一套,用户找不到自己刚导出的东西。
 *
 * 单独成文件而不是塞进 types.ts:那边约定只放类型,不放任何运行时代码。
 */

/** 文件名里非法的那些字符,各平台取并集 */
const ILLEGAL = /[\\/:*?"<>|]/g

export function sanitizeName(name: string): string {
  return name.replace(ILLEGAL, '_').slice(0, 50) || 'design'
}

export function exportDirName(projectName: string | undefined, version: number): string {
  return `${sanitizeName(projectName ?? '')}-v${version}`
}
