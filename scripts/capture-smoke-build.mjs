/**
 * 冒烟 bundle 构建:把 scripts/capture-smoke.ts 打成 .capture-smoke.cjs。
 *
 * 为什么要打桩:protocol.ts 顺带 import 了 db/repo 与 storage(artifact 路由用),
 * 而 db/migrations.ts 用了 import.meta.glob——那是 Vite 编译期能力,脱离
 * electron-vite 就不存在。冒烟只走 session 路由,db/storage 一律替换成
 * "碰到就抛"的桩,真被调用会立刻暴露而不是静默错。
 *
 * esbuild 不是直接依赖,从 .pnpm 里现找(dev-only 脚本,能跑就行)。
 */
import { readdirSync } from 'fs'
import { fileURLToPath } from 'url'
import { join } from 'path'

const pnpmDir = fileURLToPath(new URL('../node_modules/.pnpm', import.meta.url))
const esbuildPkg = readdirSync(pnpmDir)
  .filter((n) => /^esbuild@\d/.test(n))
  .sort()
  .pop()
if (!esbuildPkg) throw new Error('在 node_modules/.pnpm 里找不到 esbuild')

const esbuild = await import(join(pnpmDir, esbuildPkg, 'node_modules/esbuild/lib/main.js'))

const STUB = `module.exports = new Proxy({}, {
  get: (_t, name) => () => { throw new Error('smoke 里 ' + String(name) + ' 被打桩,不该被调用') }
})`

await esbuild.build({
  entryPoints: [fileURLToPath(new URL('./capture-smoke.ts', import.meta.url))],
  bundle: true,
  platform: 'node',
  packages: 'external',
  outfile: fileURLToPath(new URL('../.capture-smoke.cjs', import.meta.url)),
  plugins: [
    {
      name: 'stub-db-storage',
      setup(build) {
        build.onResolve({ filter: /\/db\/repo\/|\/storage\/service/ }, (args) => ({
          path: args.path,
          namespace: 'smoke-stub'
        }))
        build.onLoad({ filter: /.*/, namespace: 'smoke-stub' }, () => ({
          contents: STUB,
          loader: 'js'
        }))
      }
    }
  ]
})
console.log('[smoke-build] .capture-smoke.cjs 就绪')
