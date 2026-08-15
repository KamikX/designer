/**
 * 截图链路的真机冒烟:真实 Electron 里跑 preview://session 协议 + 离屏截图,
 * 验证 vitest 覆盖不到的那段(协议注册、窗口渲染、ready 信号、PNG 产出)。
 *
 * 跑法(入口必须落在项目根,VENDOR_DIR 按 app.getAppPath() 找 resources):
 *   npx esbuild scripts/capture-smoke.ts --bundle --platform=node \
 *     --packages=external --outfile=.capture-smoke.cjs
 *   npx electron .capture-smoke.cjs
 *
 * 输出截图到 SMOKE_OUT(缺省 /tmp),全部通过退出码 0。
 */
import { writeFileSync } from 'fs'
import { join } from 'path'
import { app } from 'electron'
import { capturePreview } from '../src/main/preview/capture'
import { registerAppSchemes, registerPreviewHandler } from '../src/main/preview/protocol'
import { registerSessionPreview } from '../src/main/preview/session-registry'

registerAppSchemes()
// 截图窗口用完即毁,两个用例之间会出现"零窗口"瞬间——不拦住默认退出,
// 第二个用例的 loadURL 会被 quit 流程掐断。真实应用主窗口常驻,没有这个问题
app.on('window-all-closed', () => {})

const HTML_FILES = [
  {
    path: 'index.html',
    content: `<!doctype html><html><body style="font-family: system-ui; padding: 40px">
<h1 style="color: #111">html 栈冒烟 OK</h1>
<p style="color: #555">这行文字应该出现在截图里。</p>
</body></html>`
  }
]

const VUE_FILES = [
  {
    path: 'App.vue',
    content: `<script setup lang="ts">
const msg = 'vue3 栈冒烟 OK'
</script>
<template>
  <main style="padding: 40px; font-family: system-ui">
    <h1>{{ msg }}</h1>
    <button type="button">一个按钮</button>
  </main>
</template>`
  },
  { path: 'theme.css', content: ':root { --color-bg: #fafafa; }' }
]

/** 编译失败场景:页面应报错,截图仍要产出(白屏也是信息) */
const BROKEN_FILES = [
  {
    path: 'App.vue',
    content: `<script setup lang="ts">\nconst = broken\n</script>\n<template><div>x</div></template>`
  }
]

interface Case {
  name: string
  sessionId: string
  stack: 'html' | 'vue3'
  files: { path: string; content: string }[]
  viewport: { width: number; height: number }
  /** 期待正常挂载,还是期待拿到错误 */
  expect: 'ready' | 'error'
}

const CASES: Case[] = [
  {
    name: 'vue',
    sessionId: 'smoke-vue',
    stack: 'vue3',
    files: VUE_FILES,
    viewport: { width: 390, height: 844 },
    expect: 'ready'
  },
  {
    name: 'html',
    sessionId: 'smoke-html',
    stack: 'html',
    files: HTML_FILES,
    viewport: { width: 1280, height: 800 },
    expect: 'ready'
  },
  {
    name: 'broken',
    sessionId: 'smoke-broken',
    stack: 'vue3',
    files: BROKEN_FILES,
    viewport: { width: 640, height: 480 },
    expect: 'error'
  }
]

console.log('[smoke] 启动,等待 app ready…')
void app.whenReady().then(async () => {
  console.log('[smoke] app ready')
  registerPreviewHandler()
  const outDir = process.env.SMOKE_OUT ?? '/tmp'
  let failures = 0

  for (const c of CASES) {
    console.log(`[smoke] ${c.name}: 开始`)
    registerSessionPreview(c.sessionId, { stack: c.stack, libs: [], files: () => c.files })
    try {
      const result = await capturePreview(`preview://session/${c.sessionId}/`, c.viewport)
      const file = join(outDir, `capture-smoke-${c.name}.png`)
      writeFileSync(file, result.png)

      const ok =
        c.expect === 'ready'
          ? result.ready && !result.error && result.png.length > 1000
          : !!result.error && result.png.length > 0
      if (!ok) failures++
      console.log(
        `[smoke] ${c.name}: ${ok ? 'ok' : 'FAIL'} ready=${result.ready} ` +
          `error=${result.error ? JSON.stringify(result.error.slice(0, 120)) : 'null'} ` +
          `png=${result.png.length}B → ${file}`
      )
    } catch (err) {
      failures++
      console.log(`[smoke] ${c.name}: FAIL threw ${err instanceof Error ? err.message : err}`)
    }
  }

  console.log(failures === 0 ? '[smoke] 全部通过' : `[smoke] ${failures} 个用例失败`)
  app.exit(failures === 0 ? 0 : 1)
})
