import { copyFileSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 把预览运行时需要的浏览器端脚本从 node_modules 拷到 resources/preview-vendor。
 *
 * 这些脚本经 preview://vendor/* 注入 iframe,让 vue3/react/tailwind 都在
 * 本地跑,预览零网络依赖。挂在 postinstall,升级依赖时自动同步;
 * resources 目录整体在 .gitignore 之外,electron-builder 原样打包。
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const target = join(root, 'resources', 'preview-vendor')
mkdirSync(target, { recursive: true })

const FILES = [
  ['vue/dist/vue.global.prod.js', 'vue.global.js'],
  ['vue3-sfc-loader/dist/vue3-sfc-loader.js', 'vue3-sfc-loader.js'],
  ['react/umd/react.production.min.js', 'react.js'],
  ['react-dom/umd/react-dom.production.min.js', 'react-dom.js'],
  ['@babel/standalone/babel.min.js', 'babel.js'],
  ['@tailwindcss/browser/dist/index.global.js', 'tailwind.js']
]

for (const [from, to] of FILES) {
  copyFileSync(join(root, 'node_modules', from), join(target, to))
  console.log(`preview-vendor: ${to}`)
}
