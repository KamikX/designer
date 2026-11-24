/**
 * Packaged-app integration check. Launch a test app with DESIGNER_DEBUG_PORT,
 * ANTD_DESIGNER_HOME pointing to an empty disposable directory, and English UI.
 * Then run: SMOKE_DATA_DIR=/tmp/... node scripts/libraries-smoke.mjs
 * Installs public npm packages, creates test projects, and blocks HTTP(S) for previews.
 */
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const root = process.env.SMOKE_DATA_DIR
assert(
  root && resolve(root).startsWith('/tmp/'),
  'SMOKE_DATA_DIR must be a disposable /tmp directory'
)
const port = process.env.DESIGNER_DEBUG_PORT ?? '9235'
const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
const target = targets.find((t) => t.type === 'page' && t.url.includes('index.html'))
assert(target, 'App renderer is not running')
const socket = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((done, fail) => {
  socket.onopen = done
  socket.onerror = fail
})
let sequence = 0
const pending = new Map()
socket.onmessage = (event) => {
  const data = JSON.parse(event.data)
  const request = pending.get(data.id)
  if (!request) return
  pending.delete(data.id)
  if (data.error) request.reject(new Error(JSON.stringify(data.error)))
  else request.resolve(data.result)
}
socket.onclose = () => {
  for (const request of pending.values()) request.reject(new Error('App debug connection closed'))
  pending.clear()
}
const send = (method, params = {}, sessionId) =>
  new Promise((resolve, reject) => {
    const id = ++sequence
    pending.set(id, { resolve, reject })
    socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
  })
async function evaluate(expression, contextId, sessionId) {
  const result = await send(
    'Runtime.evaluate',
    {
      expression,
      awaitPromise: true,
      returnByValue: true,
      ...(contextId ? { contextId } : {})
    },
    sessionId
  )
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails))
  return result.result.value
}
async function waitFor(expression, timeout = 15000, contextId, sessionId) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const result = await evaluate(expression, contextId, sessionId)
    if (result) return result
    await new Promise((done) => setTimeout(done, 150))
  }
  throw new Error(`Timed out: ${expression}`)
}
try {
  await send('Runtime.enable')
  await send('Page.enable')
  await send('Target.setDiscoverTargets', { discover: true })
  await evaluate(`location.hash = '#/settings'`)
  await waitFor(`document.querySelector('.settings-nav-item')`)
  await evaluate(
    `[...document.querySelectorAll('.settings-nav-item')].find(e => e.textContent.trim() === 'Libraries').click()`
  )
  await waitFor(`document.querySelector('.libraries-panel')`)
  const installed = await evaluate(`window.api.libraries.list()`)
  if (!installed.some((lib) => lib.name === 'zod' && lib.version === '4.4.3')) {
    await evaluate(`document.querySelector('.libraries-panel > button').click()`)
    await waitFor(`document.querySelector('.library-form')`)
    await evaluate(`(() => {
    const inputs = document.querySelectorAll('.library-form input.ant-input');
    for (const [el, value] of [[inputs[0], 'zod'], [inputs[1], '4.4.3'], [inputs[2], 'Schema validation']]) {
      el.value = value; el.dispatchEvent(new Event('input', { bubbles: true }));
    }
    const areas = document.querySelectorAll('.library-form textarea');
    areas[0].value = 'Use z.object for forms.'; areas[0].dispatchEvent(new Event('input', { bubbles: true }));
    areas[1].value = 'zod/v4'; areas[1].dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('.ant-modal-footer .ant-btn-primary').click();
  })()`)
    await waitFor(
      `(() => { const error = document.querySelector('.library-form .ant-alert-error'); if (error) throw new Error(error.textContent); return document.querySelector('.libraries-panel')?.textContent.includes('zod@4.4.3'); })()`,
      90000
    )
  }
  console.log('Packaged UI installation: zod@4.4.3 OK')
  const tv = { version: '3.2.2' }
  const extra = [
    { name: 'zod', version: '4.4.2', subpaths: [], css: [] },
    { name: 'tailwind-variants', version: tv.version, subpaths: [], css: [] },
    { name: 'nprogress', version: '0.2.0', subpaths: [], css: ['nprogress.css'] }
  ]
  for (const lib of extra) {
    if (
      installed.some((existing) => existing.name === lib.name && existing.version === lib.version)
    )
      continue
    await evaluate(
      `window.api.libraries.install(${JSON.stringify({ ...lib, stacks: ['vue3', 'react'], description: 'Integration test', instructions: 'Use explicit imports.' })})`
    )
    console.log(`Packaged installation: ${lib.name}@${lib.version} OK`)
  }
  const refs = [
    { name: 'zod', version: '4.4.3' },
    { name: 'tailwind-variants', version: tv.version },
    { name: 'nprogress', version: '0.2.0' }
  ]
  const projects = []
  for (const stack of ['vue3', 'react']) {
    const project = await evaluate(
      `window.api.project.create(${JSON.stringify({ name: `Offline ${stack}`, stack, designMode: 'design', externalLibraries: refs })})`
    )
    projects.push(project)
  }
  const db = new DatabaseSync(join(root, 'designer.db'))
  try {
    for (const project of projects) {
      const id = `smoke-${project.id}`
      db.prepare(
        'INSERT INTO artifacts (id, project_id, message_id, version, summary) VALUES (?, ?, ?, 1, ?)'
      ).run(id, project.id, `message-${project.id}`, 'Offline smoke')
      const source =
        project.stack === 'vue3'
          ? `<script setup lang="ts">import { z } from 'zod'; import { tv } from 'tailwind-variants'; import NProgress from 'nprogress'; NProgress.configure({showSpinner:false}); const title = z.string().parse('Offline Vue OK'); const classes = tv({base:'font-bold'})();</script><template><main :class="classes" style="padding:40px"><h1 id="library-result">{{title}}</h1><div id="nprogress"><div class="bar"></div></div></main></template>`
          : `import { z } from 'zod'; import { tv } from 'tailwind-variants'; import NProgress from 'nprogress'; NProgress.configure({showSpinner:false}); const classes = tv({base:'font-bold'})(); export default function App() { return <main className={classes} style={{padding:40}}><h1 id="library-result">{z.string().parse('Offline React OK')}</h1><div id="nprogress"><div className="bar"/></div></main>; }`
      db.prepare(
        'INSERT INTO artifact_files (id, artifact_id, path, content) VALUES (?, ?, ?, ?)'
      ).run(`file-${project.id}`, id, project.stack === 'vue3' ? 'App.vue' : 'App.tsx', source)
    }
  } finally {
    db.close()
  }
  await send('Network.enable')
  await send('Network.setBlockedURLs', { urls: ['http://*', 'https://*'] })
  await evaluate(
    `window.__smokeEvents=[]; window.addEventListener('message', e => { if(e.data?.__preview) window.__smokeEvents.push(e.data) }); true`
  )
  for (const project of projects) {
    await evaluate(
      `window.__smokeEvents=[]; location.hash=${JSON.stringify(`#/project/${project.id}`)}`
    )
    await waitFor(`document.querySelector('.workspace .ant-segmented-item')`)
    await evaluate(
      `[...document.querySelectorAll('.workspace .ant-segmented-item')].find(e => e.textContent.trim() === 'Preview').click()`
    )
    await waitFor(`document.querySelector('iframe')?.src.includes(${JSON.stringify(project.id)})`)
    const tree = await send('Page.getFrameTree')
    const frame = tree.frameTree.childFrames?.find((f) => f.frame.url.startsWith('preview://'))
    let contextId, sessionId
    if (frame) {
      const world = await send('Page.createIsolatedWorld', {
        frameId: frame.frame.id,
        worldName: 'library-smoke'
      })
      contextId = world.executionContextId
    } else {
      const info = await send('Target.getTargets')
      const iframe = info.targetInfos.find((t) => t.type === 'iframe' && t.url.includes(project.id))
      assert(iframe, 'Preview iframe missing')
      const attached = await send('Target.attachToTarget', {
        targetId: iframe.targetId,
        flatten: true
      })
      sessionId = attached.sessionId
      await send('Network.enable', {}, sessionId)
      await send('Network.setCacheDisabled', { cacheDisabled: true }, sessionId)
      await send('Network.setBlockedURLs', { urls: ['http://*', 'https://*'] }, sessionId)
    }
    await evaluate(`window.__smokeEvents=[]`)
    await evaluate(`document.querySelector('iframe').src = document.querySelector('iframe').src`)
    if (frame) {
      const world = await send('Page.createIsolatedWorld', {
        frameId: frame.frame.id,
        worldName: 'library-smoke'
      })
      contextId = world.executionContextId
    }
    await waitFor(
      `document.querySelector('#library-result')?.textContent.includes('OK')`,
      15000,
      contextId,
      sessionId
    )
    assert.deepEqual(await evaluate(`window.__smokeEvents.filter(e => e.type === 'error')`), [])
    const result = await evaluate(
      `({ text: document.querySelector('#library-result')?.textContent, weight: getComputedStyle(document.querySelector('main')).fontWeight, color: getComputedStyle(document.querySelector('#nprogress .bar')).backgroundColor })`,
      contextId,
      sessionId
    )
    assert(result.text?.includes('OK'))
    assert.equal(result.weight, '700')
    assert.equal(result.color, 'rgb(34, 153, 221)')
    const screenshot = await send('Page.captureScreenshot')
    writeFileSync(join(root, `${project.stack}.png`), Buffer.from(screenshot.data, 'base64'))
    console.log(`Offline ${project.stack} preview, Tailwind classes and installed CSS: OK`)
  }
  const uninstallError = await evaluate(
    `window.api.libraries.remove(${JSON.stringify(refs[0])}).then(() => null, e => e.message)`
  )
  assert(uninstallError.includes('Offline'), 'Uninstall should list referencing projects')
  console.log('Uninstall protection and project references: OK')
  console.log('PASS: packaged app installed and rendered libraries without system Node/npm.')
} finally {
  socket.close()
}
