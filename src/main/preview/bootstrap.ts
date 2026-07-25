import type { Stack } from '../../shared/types'

/**
 * vue3 / react 技术栈的 iframe 引导 HTML(html 栈直出用户文件,不走这里)。
 *
 * 引导页由我们生成而不是 AI:挂载逻辑、错误上抛、Tailwind 注入这些基建必须
 * 稳定可控。所有资源走 preview://vendor/*,零网络依赖。
 *
 * ## iframe 里没有编译器
 *
 * 以前这里塞了 vue3-sfc-loader(1.8MB)和 Babel(2.4MB),外加一套手写的
 * CommonJS require + 依赖爬取。现在 SFC / JSX 都在主进程编译好、由 preview://
 * 协议直出成 ES 模块(见 compile.ts),iframe 里只剩:
 *
 * 1. 一个原生 import map,把裸导入(vue / react)指到 vendor 里的 ESM 文件
 * 2. 一段 `import('./App.vue')` 的挂载代码
 *
 * `./Foo.vue` 这种相对导入由**浏览器自己**发请求,协议那头编译好返回——
 * 不需要任何爬取、注册表或求值排序代码。
 *
 * Electron 43 的 Chromium 原生支持 import map,不需要 es-module-shims。
 */

/**
 * 裸导入的映射表。
 *
 * **加一个依赖就是在这里加一行**,再在 scripts/prepare-preview-vendor.mjs 里
 * 把对应的 ESM 文件拷/生成到 vendor 目录。不用再动任何 loader 的内部逻辑——
 * 这正是从 vue3-sfc-loader 那套换过来的主要收益。
 */
const VENDOR_IMPORTS: Record<string, string> = {
  vue: 'preview://vendor/vue.esm.js',
  react: 'preview://vendor/react.esm.js',
  'react-dom': 'preview://vendor/react-dom.esm.js',
  // React 18 的 createRoot 官方入口是 react-dom/client,但 UMD 构建里两者
  // 同一个对象,指到同一个文件即可
  'react-dom/client': 'preview://vendor/react-dom.esm.js'
}

/** @param extra 项目级追加的映射,留给"用户自己加依赖"用 */
export function buildImportMap(extra?: Record<string, string>): string {
  const imports = { ...VENDOR_IMPORTS, ...extra }
  return `<script type="importmap">${JSON.stringify({ imports })}</script>`
}

/**
 * 设计 token 注入。
 *
 * theme.css 里是 Tailwind v4 的 @theme 块,必须以 <style type="text/tailwindcss">
 * 的形式交给浏览器版 Tailwind 才会被编译成工具类。
 *
 * 在主进程生成 HTML 时就把内容内联进去,而不是让 iframe 去 fetch:
 * fetch 是异步的,Tailwind 可能已经先扫过一遍 DOM 了,那样首帧会闪一下
 * 无样式内容。内联没有这个时序问题。
 */
function themeTag(theme: string | undefined): string {
  if (!theme?.trim()) return ''
  return `<style type="text/tailwindcss">\n${theme}\n</style>`
}

const COMMON_HEAD = `
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<script src="preview://vendor/tailwind.js"></script>
<style>html, body, #app { min-height: 100%; } body { margin: 0; }</style>
<script>
  // 有些库(含 React 的部分构建)会读 process.env,给个空壳免得直接 ReferenceError
  window.process = window.process || { env: { NODE_ENV: 'production' } }

  function reportError(message) {
    parent.postMessage({ __preview: true, type: 'error', message: String(message) }, '*')
  }
  window.onerror = function (msg, _src, _line, _col, err) {
    reportError((err && err.stack) || msg)
  }
  window.addEventListener('unhandledrejection', function (e) {
    reportError((e.reason && (e.reason.stack || e.reason.message)) || e.reason)
  })

  /*
   * 告诉外层"可以撤掉骨架屏了"。
   *
   * 为什么不能让外层监听 iframe 的 load 事件:vue3 / react 栈要等模块图加载完
   * 并挂载,load 早在那之前就触发了。那时撤掉骨架屏,用户会盯着一片白。
   *
   * 双层 rAF:第一层等布局,第二层等这一帧真的画完。少一层会在内容还没上屏
   * 时就撤掉遮罩,闪一下白。
   */
  function notifyReady() {
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        parent.postMessage({ __preview: true, type: 'ready' }, '*')
      })
    })
  }
  // html 栈没有挂载步骤,load 就是它的就绪点;vue3 / react 会把这个标记置为
  // true,改由各自挂载完成后自己发
  window.__previewAwaitMount = false
  window.addEventListener('load', function () {
    if (!window.__previewAwaitMount) notifyReady()
  })
</script>
`

/**
 * 挂载脚本。
 *
 * 用**动态 import 包在 try/catch 里**,而不是顶层静态 import:静态 import 失败
 * (文件 404、编译报错、语法错误)只会在控制台留一条,用户看到的是白屏。动态
 * import 返回的是 promise,失败能接住,再走 reportError 显示到预览面板,并回流
 * 给模型。这条链是"模型知道自己写的东西跑不跑得起来"的唯一来源。
 */
const VUE_BOOT = `
<script type="module">
  window.__previewAwaitMount = true
  try {
    const { createApp } = await import('vue')
    const App = (await import('./App.vue')).default
    if (!App) throw new Error('App.vue 需要默认导出根组件')
    createApp(App).mount('#app')
    notifyReady()
  } catch (err) {
    reportError((err && err.stack) || err.message || err)
  }
</script>
`

const REACT_BOOT = `
<script type="module">
  window.__previewAwaitMount = true
  try {
    const React = (await import('react')).default
    const { createRoot } = await import('react-dom/client')
    /*
     * 先试 .tsx 再退 .jsx。默认产出已经改成 TypeScript,但库里还躺着一批
     * 早先生成的 .jsx 版本——它们打开时也该正常显示,不能因为改了默认值
     * 就让历史版本集体白屏。
     */
    let mod
    try {
      mod = await import('./App.tsx')
    } catch {
      mod = await import('./App.jsx')
    }
    const App = mod.default || mod.App
    if (!App) throw new Error('App.tsx 需要默认导出根组件')
    createRoot(document.getElementById('app')).render(React.createElement(App))
    notifyReady()
  } catch (err) {
    reportError((err && err.stack) || err.message || err)
  }
</script>
`

export function buildBootstrapHtml(stack: Stack, theme?: string): string {
  const boot = stack === 'vue3' ? VUE_BOOT : REACT_BOOT
  // import map 必须出现在任何模块脚本之前,所以放在 head 最前面
  return `<!doctype html>
<html>
<head>${buildImportMap()}${COMMON_HEAD}${themeTag(theme)}</head>
<body>
<div id="app"></div>
${boot}
</body>
</html>`
}

/**
 * html 栈:直出用户的 html 文件,注入 Tailwind 与错误上抛。
 * 注入点选 </head> 前;没有 head 就 body 前兜底,再没有就直接前置。
 *
 * 不注入 import map:html 栈的页面是用户自己写的,可能已经有一个,而一个文档
 * 里出现两个 import map 会直接报错。它也用不上——没有模块要解析裸导入。
 */
export function injectHtmlRuntime(html: string, theme?: string): string {
  const inject = COMMON_HEAD + themeTag(theme)
  if (html.includes('</head>')) return html.replace('</head>', `${inject}</head>`)
  if (html.includes('<body')) return html.replace('<body', `${inject}<body`)
  return inject + html
}
