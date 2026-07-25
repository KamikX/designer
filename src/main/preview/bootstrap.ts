import type { Stack } from '../../shared/types'

/**
 * vue3 / react 技术栈的 iframe 引导 HTML(html 栈直出用户文件,不走这里)。
 *
 * 引导页由我们生成而不是 AI:挂载逻辑、错误上抛、Tailwind 注入这些
 * 基建必须稳定可控。所有脚本走 preview://vendor/*,零网络依赖。
 *
 * 错误处理是体验的生命线:iframe 里编译/运行报错默认只进控制台,
 * 用户看到的是白屏——这里统一 postMessage 给外层 PreviewPane 显示。
 */

const COMMON_HEAD = `
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<script src="preview://vendor/tailwind.js"></script>
<style>html, body, #app { min-height: 100%; } body { margin: 0; }</style>
<script>
  function reportError(message) {
    parent.postMessage({ __preview: true, type: 'error', message: String(message) }, '*')
  }
  window.onerror = function (msg, _src, _line, _col, err) {
    reportError((err && err.stack) || msg)
  }
  window.addEventListener('unhandledrejection', function (e) {
    reportError((e.reason && (e.reason.stack || e.reason.message)) || e.reason)
  })
</script>
`

const VUE_BOOT = `
<script src="preview://vendor/vue.global.js"></script>
<script src="preview://vendor/vue3-sfc-loader.js"></script>
<script>
  const { loadModule } = window['vue3-sfc-loader']
  const options = {
    moduleCache: { vue: Vue },
    async getFile(url) {
      const res = await fetch(url)
      if (!res.ok) throw new Error('文件不存在: ' + url)
      return { getContentData: () => res.text() }
    },
    addStyle(text) {
      const style = document.createElement('style')
      style.textContent = text
      document.head.appendChild(style)
    },
    handleModule: undefined
  }
  loadModule('./App.vue', options)
    .then((App) => Vue.createApp(App).mount('#app'))
    .catch((err) => reportError(err.stack || err.message || err))
</script>
`

const REACT_BOOT = `
<script src="preview://vendor/react.js"></script>
<script src="preview://vendor/react-dom.js"></script>
<script src="preview://vendor/babel.js"></script>
<script>
  // 迷你模块加载器:先异步爬取并转译整棵依赖树(Babel 把 ESM 转成
  // CommonJS),再同步执行——因为 require 必须是同步的。
  const registry = new Map()   // path -> 转译后代码
  const resolved = new Map()   // from + '\\0' + spec -> path
  const executed = new Map()   // path -> module.exports

  async function fetchCandidate(path) {
    for (const candidate of [path, path + '.jsx', path + '.js']) {
      const res = await fetch(candidate)
      if (res.ok) return { path: candidate, source: await res.text() }
    }
    throw new Error('文件不存在: ' + path)
  }

  function resolveSpec(from, spec) {
    const base = new URL(from, location.href)
    return new URL(spec, base).pathname
  }

  async function crawl(from, spec) {
    const key = from + '\\0' + spec
    if (resolved.has(key)) return
    const target = await fetchCandidate(resolveSpec(from, spec))
    resolved.set(key, target.path)
    if (registry.has(target.path)) return
    // classic runtime:JSX 编译成 React.createElement,直接吃 UMD 全局,
    // 不需要 react/jsx-runtime 模块
    const code = Babel.transform(target.source, {
      filename: target.path,
      presets: [['react', { runtime: 'classic' }], ['env', { modules: 'commonjs' }]]
    }).code
    registry.set(target.path, code)
    const deps = [...code.matchAll(/require\\((['"])(.+?)\\1\\)/g)]
      .map((m) => m[2])
      .filter((s) => s.startsWith('.'))
    for (const dep of deps) await crawl(target.path, dep)
  }

  function execute(path) {
    if (executed.has(path)) return executed.get(path)
    const module = { exports: {} }
    executed.set(path, module.exports)
    const requireFn = (spec) => {
      if (spec === 'react') return React
      if (spec === 'react-dom' || spec === 'react-dom/client') return ReactDOM
      if (spec === 'react/jsx-runtime') {
        // 万一模型自己写了 automatic runtime 的产物,给个等价 shim
        const jsx = (type, props, key) =>
          React.createElement(type, key === undefined ? props : { ...props, key })
        return { jsx, jsxs: jsx, Fragment: React.Fragment }
      }
      const dep = resolved.get(path + '\\0' + spec)
      if (!dep) throw new Error('未解析的依赖: ' + spec)
      return execute(dep)
    }
    new Function('require', 'module', 'exports', registry.get(path))(
      requireFn, module, module.exports
    )
    executed.set(path, module.exports)
    return module.exports
  }

  crawl(location.pathname, './App.jsx')
    .then(() => {
      const entry = resolved.get(location.pathname + '\\0./App.jsx')
      const mod = execute(entry)
      const App = mod.default || mod.App
      if (!App) throw new Error('App.jsx 需要默认导出根组件')
      ReactDOM.createRoot(document.getElementById('app')).render(React.createElement(App))
    })
    .catch((err) => reportError(err.stack || err.message || err))
</script>
`

export function buildBootstrapHtml(stack: Stack): string {
  const boot = stack === 'vue3' ? VUE_BOOT : REACT_BOOT
  return `<!doctype html>
<html>
<head>${COMMON_HEAD}</head>
<body>
<div id="app"></div>
${boot}
</body>
</html>`
}

/**
 * html 栈:直出用户的 html 文件,注入 Tailwind 与错误上抛。
 * 注入点选 </head> 前;没有 head 就 body 前兜底,再没有就直接前置。
 */
export function injectHtmlRuntime(html: string): string {
  const inject = COMMON_HEAD
  if (html.includes('</head>')) return html.replace('</head>', `${inject}</head>`)
  if (html.includes('<body')) return html.replace('<body', `${inject}<body`)
  return inject + html
}
