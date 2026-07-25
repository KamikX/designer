import { readFileSync } from 'fs'
import { join } from 'path'
import { app } from 'electron'

/**
 * 读取要注入进无头窗口的第三方脚本。
 *
 * 和 preview:// 共用同一个 vendor 目录(打包配置里已经整体解包),但走的是
 * 文件读取而不是自定义协议——注入的目标是**任意外部网站**,那里没有我们的
 * 协议,只能把源码整段塞进 executeJavaScript。
 *
 * 读一次就缓存:defuddle 有 700KB,每抓一个页面重读一次磁盘没有意义。
 */
const cache = new Map<string, string>()

export function readVendor(file: string): string {
  const hit = cache.get(file)
  if (hit !== undefined) return hit

  const source = readFileSync(join(app.getAppPath(), 'resources', 'preview-vendor', file), 'utf-8')
  cache.set(file, source)
  return source
}
