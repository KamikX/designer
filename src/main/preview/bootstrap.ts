import type { PreviewLib, Stack } from '../../shared/types'
import { LIB_VERSIONS, libSetupPaths } from './lib-setup'

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

/* ------------------------------------------------------------------ */
/* 项目勾选的组件库(CDN)。接入模式与新增清单见 docs/preview-libs.md    */
/* ------------------------------------------------------------------ */

/**
 * 版本**锁死**,不用 latest:预览产物要可复现,CDN 上的 latest 会让上个月的
 * 版本今天打不开。升级 = 改这里 + 按 docs/preview-libs.md 回归验收。
 *
 * 依赖闭包(实测自 antdv-next-playground 调研):
 * - antd.esm.js 唯一的裸导入是 "vue"——dayjs 及其 6 个插件、cssinjs、
 *   @v-c/util 全部内联在 bundle 里,import map **不需要也不应该**补 dayjs
 *   (补了会出现第二个 dayjs 实例,locale/插件状态不互通);
 * - vue 必须 >= 3.5(bundle 里用了 onWatcherCleanup),且必须与页面同一份
 *   实例——正好复用我们 vendor 的 vue 映射,天然满足;
 * - antdv-next >= 1.0.4 才有 dist/antd.esm.js;
 * - icons 的依赖(@ant-design/colors 等)同样全内联,零额外条目。
 */
const LIB_CDN = 'https://cdn.jsdelivr.net/npm/'

function libImports(libs: PreviewLib[]): Record<string, string> {
  const imports: Record<string, string> = {}
  if (libs.includes('antdv-next')) {
    const base = `${LIB_CDN}antdv-next@${LIB_VERSIONS['antdv-next']}`
    imports['antdv-next'] = `${base}/dist/antd.esm.js`
    // 尾斜杠前缀映射:让 antdv-next/dist/locale/zh_CN.js 这类子路径也能解析。
    // 注意它只做字符串替换,不补扩展名——不带 .js 的子路径照样 404
    imports['antdv-next/'] = `${base}/`
  }
  if (libs.includes('@antdv-next/icons')) {
    const base = `${LIB_CDN}@antdv-next/icons@${LIB_VERSIONS['@antdv-next/icons']}`
    imports['@antdv-next/icons'] = `${base}/dist/antd-icons.esm.js`
    imports['@antdv-next/icons/'] = `${base}/`
  }
  return imports
}

/*
 * 样式与 app.use 的装配不在这里:每个依赖包一个 setup 虚拟模块
 * (`__setup__/<名字>.js`,见 lib-setup.ts),引导脚本按勾选依次 await。
 * CSS 在 setup 里用 <link> + load/error 事件加载——CDN 挂了能报出
 * 具体 URL,而不是无声裸奔。
 */

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
  // 兜底剥掉 @import 'tailwindcss':运行时已内置,重复引入会冲突。
  // 提示词里禁了,但历史版本的产物和走神的模型都可能带着它
  const cleaned = theme.replace(/@import\s+(['"])tailwindcss\1\s*;?/g, '')
  return `<style type="text/tailwindcss">\n${cleaned}\n</style>`
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
const vueBoot = (setups: string[], withAntd: boolean): string => `
<script type="module">
  window.__previewAwaitMount = true
  try {
    const { createApp } = await import('vue')
    const App = (await import('./App.vue')).default
    if (!App) throw new Error('App.vue 需要默认导出根组件')
    const app = createApp(App)
    ${setups
      .map(
        (path) => `// 依赖包装配(样式 + app.use),模块由协议层直出,不在产物文件树里
    await (await import(${JSON.stringify(path)})).default(app)`
      )
      .join('\n    ')}
    app.mount('#app')
    ${
      withAntd
        ? ''
        : `/*
     * 守边界的报错:没勾 antdv-next 却写了 <a-xxx> 组件时,生产构建的 vue
     * 会**静默**把它当普通元素渲染(属性全变 [object Object]),没有任何
     * 报错——用户只看到一个坏页面。这里挂载后扫一遍,把原因说成人话,
     * 走错误回流让模型和用户都知道该怎么办。
     */
    const stray = [...document.querySelectorAll('#app *')].find(
      (el) => el.tagName.toLowerCase().startsWith('a-')
    )
    if (stray) {
      reportError(
        '页面用了 ' + stray.tagName.toLowerCase() + ' 等 antdv-next 组件,' +
        '但本项目没有勾选 antdv-next 依赖包。在工作台右上角的「依赖包」里勾上它,' +
        '或者改用原生元素实现。'
      )
    }`
    }
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

export function buildBootstrapHtml(stack: Stack, theme?: string, libs: PreviewLib[] = []): string {
  // 组件库目前只有 vue3 栈的运行时装配;别的栈传进来也不生效
  const activeLibs = stack === 'vue3' ? libs : []
  const boot =
    stack === 'vue3'
      ? vueBoot(libSetupPaths(activeLibs), activeLibs.includes('antdv-next'))
      : REACT_BOOT
  // import map 必须出现在任何模块脚本之前,所以放在 head 最前面
  return `<!doctype html>
<html>
<head>${buildImportMap(libImports(activeLibs))}${COMMON_HEAD}${themeTag(theme)}</head>
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
