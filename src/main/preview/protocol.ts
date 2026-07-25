import { readFileSync } from 'fs'
import { extname, join, normalize, sep } from 'path'
import { app, protocol } from 'electron'
import { getArtifact, getArtifactFiles } from '../db/repo/artifact'
import { getProject } from '../db/repo/project'
import { buildBootstrapHtml, injectHtmlRuntime } from './bootstrap'

/**
 * preview:// 协议:iframe 预览的静态服务。
 *
 *   preview://artifact/<artifactId>/<path>   设计稿文件,直接查 DB
 *   preview://vendor/<file>                  内置运行时脚本(resources/preview-vendor)
 *
 * 文件从 DB 直出而不是物化到磁盘:没有双写一致性问题,版本切换就是
 * 换个查询条件。二期换 esbuild 打包也只动这里的内部实现,URL 面不变。
 */

/**
 * 必须在 app ready 之前调用,且 registerSchemesAsPrivileged 全应用只能
 * 调一次——所有自定义 scheme(preview 预览、asset 资源)都收在这里注册。
 */
export function registerAppSchemes(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: 'preview',
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true
      }
    },
    {
      scheme: 'asset',
      privileges: { standard: true, secure: true, supportFetchAPI: true }
    }
  ])
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.jsx': 'text/javascript; charset=utf-8',
  '.vue': 'text/plain; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.md': 'text/plain; charset=utf-8'
}

function mimeOf(path: string): string {
  return MIME[extname(path).toLowerCase()] ?? 'text/plain; charset=utf-8'
}

/** app ready 之后调用 */
export function registerAssetHandler(): void {
  protocol.handle('asset', async (request) => {
    try {
      // asset://<id> —— standard scheme 会把 host 小写,而 ULID 是大写,
      // 这里按小写化后的 host 反查不可行,所以资源 id 统一转大写比对
      const id = new URL(request.url).host.toUpperCase()
      const { resolveAsset } = await import('../storage/service')
      const hit = await resolveAsset(id)
      if (!hit) return new Response('Not Found', { status: 404 })
      return new Response(new Uint8Array(hit.data), {
        headers: { 'content-type': hit.mime, 'cache-control': 'max-age=31536000, immutable' }
      })
    } catch (err) {
      return new Response(`资源服务错误: ${err instanceof Error ? err.message : err}`, {
        status: 500
      })
    }
  })
}

/** app ready 之后调用 */
export function registerPreviewHandler(): void {
  protocol.handle('preview', (request) => {
    try {
      const url = new URL(request.url)
      // standard scheme 会把 host 小写化,所以 host 只放固定词,
      // 大小写敏感的 ULID 都在 pathname 里
      if (url.host === 'vendor') return serveVendor(url.pathname)
      if (url.host === 'artifact') return serveArtifact(url.pathname)
      return new Response('Not Found', { status: 404 })
    } catch (err) {
      return new Response(`预览服务错误: ${err instanceof Error ? err.message : err}`, {
        status: 500
      })
    }
  })
}

const VENDOR_DIR = join(app.getAppPath(), 'resources', 'preview-vendor')

function serveVendor(pathname: string): Response {
  // 防穿越:归一化后必须仍在 vendor 目录内
  const target = normalize(join(VENDOR_DIR, pathname))
  if (!target.startsWith(VENDOR_DIR + sep)) return new Response('Forbidden', { status: 403 })
  try {
    return new Response(readFileSync(target), {
      headers: { 'content-type': mimeOf(target), 'cache-control': 'no-cache' }
    })
  } catch {
    return new Response('Not Found', { status: 404 })
  }
}

function serveArtifact(pathname: string): Response {
  // pathname 形如 /<artifactId>/<filePath...>
  const [, artifactId, ...rest] = pathname.split('/')
  const filePath = decodeURIComponent(rest.join('/'))

  const artifact = artifactId ? getArtifact(artifactId) : null
  if (!artifact) return new Response('Artifact Not Found', { status: 404 })
  const project = getProject(artifact.projectId)
  if (!project) return new Response('Project Not Found', { status: 404 })

  const files = getArtifactFiles(artifact.id)
  const isEntry = filePath === '' || filePath === 'index.html'

  // vue3 / react:入口出引导页,其余文件按名直出(引导页里 fetch 用)
  if (isEntry && project.stack !== 'html') {
    return html(buildBootstrapHtml(project.stack))
  }

  const entryName = filePath === '' ? 'index.html' : filePath
  const file = files.find((f) => f.path === entryName)
  if (!file) return new Response('Not Found', { status: 404 })

  // html 栈的 html 文件注入 Tailwind 运行时与错误上抛
  if (project.stack === 'html' && entryName.endsWith('.html')) {
    return html(injectHtmlRuntime(file.content))
  }
  return new Response(file.content, {
    headers: { 'content-type': mimeOf(entryName), 'cache-control': 'no-cache' }
  })
}

function html(content: string): Response {
  return new Response(content, {
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' }
  })
}
