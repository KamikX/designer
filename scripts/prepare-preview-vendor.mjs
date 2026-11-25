import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 生成预览 iframe 用的 vendor 资产,放在 resources/preview-vendor,
 * 经 preview://vendor/* 注入。挂在 postinstall,升级依赖时自动同步。
 *
 * ## 为什么这里全是 ESM
 *
 * iframe 里不再塞编译器(以前是 vue3-sfc-loader 1.8MB + Babel 2.4MB)。SFC / JSX
 * 都在主进程编译好,由 preview:// 协议直出成 ES 模块;iframe 里只剩一个原生
 * import map,把裸导入指到这些文件上。
 *
 * 于是"加一个依赖" = import map 加一行 + 这里加一个 ESM 文件,不用再动任何
 * loader 的内部逻辑。
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const target = join(root, 'resources', 'preview-vendor')
const require = createRequire(import.meta.url)

// 先清空再生成:这个目录整个会被 electron-builder 打进包里,换掉的依赖
// (比如从 vue3-sfc-loader 换到服务端编译)如果只写不删,4MB 的废弃运行时
// 会一直躺在安装包里,而且没人会注意到
rmSync(target, { recursive: true, force: true })
mkdirSync(target, { recursive: true })

/** 本身就有 ESM 浏览器构建的,直接拷 */
const COPY = [
  // 运行时版就够:模板已经在主进程编译成 render 函数,不需要浏览器端编译器
  ['vue/dist/vue.runtime.esm-browser.prod.js', 'vue.esm.js'],
  ['@tailwindcss/browser/dist/index.global.js', 'tailwind.js'],
  // 正文提取。full 版才带 markdown 输出和站点专用提取器(youtube / x / 等),
  // 注入进无头窗口用,不走 preview:// —— 见 src/main/web/extract.ts
  ['defuddle/dist/index.full.js', 'defuddle.js']
]

for (const [from, to] of COPY) {
  copyFileSync(join(root, 'node_modules', from), join(target, to))
  console.log(`preview-vendor: ${to}`)
}

/**
 * React 至今**没有官方 ESM 构建**,只有 UMD 和 CJS(18.3 仍然如此)。
 *
 * 所以把 UMD 包一层:UMD 检测到有 module/exports 就走 CommonJS 分支,那就手工
 * 造一对传进去,再把结果重新导出成 ESM。
 *
 * 具名导出必须静态写出(ESM 不允许 `export * from` 一个运行时对象),导出名
 * 这里用 Node 反射真实模块拿到——写死一份清单迟早和升级后的版本对不上。
 */
function esmShim({ umd, moduleId, out, deps = {} }) {
  const source = readFileSync(join(root, 'node_modules', umd), 'utf-8')
  const names = Object.keys(require(moduleId))
    // default 单独给,别在具名里重复;非标识符的键(如 Symbol 描述)跳过
    .filter((k) => /^[A-Za-z_$][\w$]*$/.test(k) && k !== 'default')
    .sort()

  // 变量名和文件名分开:'react.esm.js' 带点,不是合法标识符
  const entries = Object.entries(deps)
  const imports = entries.map(([, d]) => `import ${d.ident} from './${d.file}'`).join('\n')
  const cases = entries.map(([spec, d]) => `  if (id === '${spec}') return ${d.ident}`).join('\n')

  writeFileSync(
    join(target, out),
    `/* 由 scripts/prepare-preview-vendor.mjs 生成,勿手改 */
${imports}
const __module__ = { exports: {} }
function __require__(id) {
${cases}
  throw new Error('Preview runtime dependency missing: ' + id)
}
// call(globalThis):ESM 里 this 是 undefined,而 UMD 头部拿 this 当全局对象。
// 这里走的是 CommonJS 分支用不到它,但别留一个 undefined 在那儿等着炸
;(function (module, exports, require) {
${source}
}).call(globalThis, __module__, __module__.exports, __require__)
const __default__ = __module__.exports
export default __default__
export const { ${names.join(', ')} } = __default__
`,
    'utf-8'
  )
  console.log(`preview-vendor: ${out} (${names.length} named exports)`)
}

esmShim({ umd: 'react/umd/react.production.min.js', moduleId: 'react', out: 'react.esm.js' })
esmShim({
  umd: 'react-dom/umd/react-dom.production.min.js',
  moduleId: 'react-dom',
  out: 'react-dom.esm.js',
  deps: { react: { file: 'react.esm.js', ident: '__React__' } }
})

writeFileSync(
  join(target, 'runtime-versions.json'),
  JSON.stringify(
    Object.fromEntries(
      ['vue', 'react', 'react-dom'].map((name) => [name, require(`${name}/package.json`).version])
    )
  )
)
writeFileSync(
  join(target, 'react-jsx-runtime.esm.js'),
  `import React from './react.esm.js';
export const Fragment = React.Fragment;
export function jsx(type, props, key) { return React.createElement(type, key === undefined ? props : { ...props, key }); }
export const jsxs = jsx;
export const jsxDEV = jsx;
`
)
