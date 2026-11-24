import { resolveLibraries, libraryFile } from '../libraries/service'
import { readFileSync } from 'fs'
import { extname, join, normalize, sep } from 'path'
import { app, protocol } from 'electron'
import { getArtifact, getArtifactFiles } from '../db/repo/artifact'
import { getProject } from '../db/repo/project'
import { resolveAsset } from '../storage/service'
import { buildBootstrapHtml, injectHtmlRuntime } from './bootstrap'
import { compilePreviewFile, isCompilable } from './compile'
import { resolveModuleFile } from './resolve'
import { libSetupSource } from './lib-setup'
import { getSessionPreview } from './session-registry'
import type { Compiled } from './compile'
import type { ExternalLibraryRef, PreviewLib, Stack } from '../../shared/types'

/**
 * preview:// 协议:iframe 预览的静态服务。
 *
 *   preview://artifact/<artifactId>/<path>   设计稿文件,直接查 DB
 *   preview://session/<sessionId>/<path>     运行中会话的 VFS 快照(截图自审用)
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
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.eot': 'application/vnd.ms-fontobject',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.jpg': 'image/jpeg',
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
      if (url.host === 'session') return serveSession(url.pathname)
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

  return serveFileSet({
    files: getArtifactFiles(artifact.id),
    stack: project.stack,
    libs: project.libs ?? [],
    externalLibraries: project.externalLibraries ?? [],
    filePath,
    // 版本产物不可变,(artifactId, path) 是天然的永久缓存键
    cacheScope: artifact.id
  })
}

function serveSession(pathname: string): Response {
  // pathname 形如 /<sessionId>/<filePath...>,内容来自运行中会话的 VFS
  const [, sessionId, ...rest] = pathname.split('/')
  const source = sessionId ? getSessionPreview(sessionId) : null
  if (!source) return new Response('Session Not Found', { status: 404 })

  return serveFileSet({
    files: source.files(),
    stack: source.stack,
    libs: source.libs,
    externalLibraries: source.externalLibraries ?? [],
    filePath: decodeURIComponent(rest.join('/')),
    // 会话内容在模型的连续编辑下随时在变,不能缓存
    cacheScope: null
  })
}

interface FileSetRequest {
  files: { path: string; content: string }[]
  stack: Stack
  libs: PreviewLib[]
  externalLibraries: ExternalLibraryRef[]
  filePath: string
  /** 非空时按 (scope, path) 缓存编译产物;null 表示内容可变,每次现编 */
  cacheScope: string | null
}

function serveFileSet({
  files,
  stack,
  libs,
  externalLibraries,
  filePath,
  cacheScope
}: FileSetRequest): Response {
  let external: ReturnType<typeof resolveLibraries>
  try {
    external = resolveLibraries(externalLibraries, stack, libs)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const script = `reportError(${JSON.stringify(message).replace(/</g, '\\u003c')})`
    return html(
      injectHtmlRuntime(`<html><head></head><body><script>${script}</script></body></html>`)
    )
  }
  if (filePath.startsWith('__libraries__/')) {
    const [, id, ...parts] = filePath.split('/')
    const lib = external.find((lib) => lib.id === id)
    if (!lib) return new Response('Library not selected', { status: 404 })
    const file = parts.join('/')
    if (!lib.files.includes(file)) return new Response('Library file not found', { status: 404 })
    const target = libraryFile(lib, file)
    try {
      return new Response(readFileSync(target), {
        headers: { 'content-type': mimeOf(target), 'cache-control': 'no-cache' }
      })
    } catch {
      return new Response('Library file not found', { status: 404 })
    }
  }
  const isEntry = filePath === '' || filePath === 'index.html'
  // 设计 token:三种栈共用同一个约定文件,由运行时统一注入,
  // 页面里不需要 link 或 import
  const theme = files.find((f) => f.path === 'theme.css')?.content

  // vue3 / react:入口出引导页,其余文件按名直出(引导页里 fetch 用)
  if (isEntry && stack !== 'html') {
    return html(buildBootstrapHtml(stack, theme, libs, external))
  }

  const requested = filePath === '' ? 'index.html' : filePath

  // 依赖包的 setup 虚拟模块:不在产物文件树里,按项目勾选直出;没勾就 404,守边界
  if (requested.startsWith('__setup__/')) {
    const code = libSetupSource(requested.slice('__setup__/'.length), libs)
    if (!code) return new Response('Not Found', { status: 404 })
    return new Response(code, {
      headers: { 'content-type': JS_MIME, 'cache-control': 'no-cache' }
    })
  }

  const file = resolveModuleFile(files, requested)
  if (!file) return new Response('Not Found', { status: 404 })
  // 后续一律用**解析到的真实路径**:编译模式、MIME、缓存键都取决于它,
  // 而不是浏览器请求里那个可能没有后缀的名字
  const entryName = file.path

  // html 栈的 html 文件注入 Tailwind 运行时与错误上抛
  if (stack === 'html' && entryName.endsWith('.html')) {
    return html(injectHtmlRuntime(file.content, theme))
  }

  // SFC / TSX / TS / CSS 编译成 ES 模块直出。浏览器解析 `import './Foo.vue'`
  // 时会自己发请求过来,再走一遍这里——不需要我们爬依赖
  if (isCompilable(entryName)) {
    try {
      const { code, mime } = cacheScope
        ? compileCached(cacheScope, entryName, file.content)
        : compilePreviewFile(entryName, file.content)
      return new Response(code, {
        headers: { 'content-type': mime, 'cache-control': 'no-cache' }
      })
    } catch (err) {
      /*
       * 返回一个**加载即抛错**的模块,而不是 500。
       *
       * 500 的响应体浏览器不会暴露给 JS——import 失败只会得到一句
       * "Failed to fetch dynamically imported module",编译器的诊断信息全丢了。
       * 而那句话对模型毫无用处:它不知道自己哪一行写错了。
       *
       * 改成 200 + 一个 throw,错误文本就会原样出现在 iframe 的 catch 里,
       * 经 postMessage → 预览面板 → reportPreviewError,下一轮进 system prompt。
       * 模型于是能看着真正的编译错误自己改。
       */
      const detail = err instanceof Error ? err.message : String(err)
      return new Response(
        `throw new Error(${JSON.stringify(`编译失败 ${entryName}\n${detail}`)})`,
        {
          headers: { 'content-type': JS_MIME, 'cache-control': 'no-cache' }
        }
      )
    }
  }

  return new Response(file.content, {
    headers: { 'content-type': mimeOf(entryName), 'cache-control': 'no-cache' }
  })
}

/**
 * 编译缓存。
 *
 * 版本产物是**不可变**的:改一次生成一个新 artifactId,老版本的内容永远不变。
 * 所以 (artifactId, path) 是一个天然的永久缓存键,不需要失效策略。
 *
 * 这比换编译器更能决定体验:一次预览要发十几个模块请求,刷新、切 tab、切版本
 * 又会重来一遍。缓存之后除首次外全是查表。
 *
 * 只按条数封顶,不按字节:编译产物是文本,几百个文件也就几 MB,而按字节算要
 * 额外维护大小统计,不划算。
 */
const CACHE_LIMIT = 500
const cache = new Map<string, Compiled>()

const JS_MIME = 'text/javascript; charset=utf-8'

function compileCached(artifactId: string, path: string, source: string): Compiled {
  const key = `${artifactId}/${path}`
  const hit = cache.get(key)
  if (hit) return hit

  const compiled = compilePreviewFile(path, source)
  // 超了就丢最早的一条(Map 保持插入序),够用的 LRU 近似
  if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value!)
  cache.set(key, compiled)
  return compiled
}

function html(content: string): Response {
  return new Response(content, {
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' }
  })
}
