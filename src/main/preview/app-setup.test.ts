// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as Vue from 'vue'
import { createMemoryHistory, createRouter, RouterView, useRoute, useRouter } from 'vue-router'
import { buildBootstrapHtml } from './bootstrap'
import type { App } from 'vue'

type Setup = (app: App) => void | Promise<void>

interface BootResult {
  errors: ReturnType<typeof vi.fn>
  ready: ReturnType<typeof vi.fn>
  imports: string[]
  order: string[]
  mount: ReturnType<typeof vi.fn>
  host?: App
}

async function runBoot(
  setup?: unknown,
  setupPath?: 'app.setup.ts' | 'app.setup.js'
): Promise<BootResult> {
  const errors = vi.fn()
  const ready = vi.fn()
  const imports: string[] = []
  const order: string[] = []
  let host: App | undefined
  let mount = vi.fn()
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      {
        path: '/',
        component: Vue.defineComponent({
          setup() {
            const route = useRoute()
            const installed = useRouter()
            return () => Vue.h('p', `${route.path}:${installed === router}`)
          }
        })
      }
    ]
  })
  const root = Vue.defineComponent({
    render: () => (setup === 'router' ? Vue.h(RouterView) : Vue.h('p', 'Component preview'))
  })
  const load = async (path: string): Promise<unknown> => {
    imports.push(path)
    if (path === 'vue') {
      return {
        createApp: (component: typeof root) => {
          host = Vue.createApp(component)
          mount = vi.spyOn(host, 'mount')
          return host
        }
      }
    }
    if (path === './App.vue') return { default: root }
    if (path === './__setup__/antdv-next.js') {
      return { default: async () => order.push('built-in') }
    }
    if (path === './app.setup.ts' || path === './app.setup.js') {
      if (setup instanceof Error) throw setup
      return {
        default:
          setup === 'router'
            ? async (app: App) => {
                expect(app).toBe(host)
                expect(mount).not.toHaveBeenCalled()
                app.use(router)
                await router.push('/')
                await router.isReady()
                order.push('project')
              }
            : setup
      }
    }
    throw new Error(`Unexpected import: ${path}`)
  }
  document.body.innerHTML = '<div id="app"></div>'
  const html = buildBootstrapHtml('vue3', undefined, ['antdv-next'], [], 'en-US', setupPath)
  const code = /<script type="module">([\s\S]*?)<\/script>/.exec(html)![1]
  // Execute the emitted bootstrap so lifecycle ordering and errors are checked beyond string matching.
  await new Function(
    'load',
    'window',
    'document',
    'reportError',
    'notifyReady',
    `return (async () => { ${code.replaceAll('import(', 'load(')} })()`
  )(load, window, document, errors, ready)
  return { errors, ready, imports, order, mount, host }
}

afterEach(() => {
  document.body.innerHTML = ''
})

describe('Vue project app setup', () => {
  it.each(['app.setup.ts', 'app.setup.js'] as const)(
    'awaits %s on the host app before mounting RouterView',
    async (path) => {
      const result = await runBoot('router', path)
      expect(result.errors).not.toHaveBeenCalled()
      expect(result.order).toEqual(['built-in', 'project'])
      expect(document.querySelector('p')?.textContent).toBe('/:true')
      expect(result.mount).toHaveBeenCalledOnce()
      expect(result.ready).toHaveBeenCalledOnce()
      result.host?.unmount()
    }
  )

  it('does not request a hook or router when no setup file exists', async () => {
    const result = await runBoot()
    expect(result.imports).toEqual(['vue', './App.vue', './__setup__/antdv-next.js'])
    expect(result.errors).not.toHaveBeenCalled()
    expect(result.mount).toHaveBeenCalledOnce()
    result.host?.unmount()
  })

  it.each([
    ['import failure', new Error('Missing setup dependency')],
    ['invalid export', {}],
    ['initialization failure', (() => Promise.reject(new Error('Plugin failed'))) satisfies Setup]
  ])('reports %s and does not mount or signal ready', async (_name, setup) => {
    const result = await runBoot(setup, 'app.setup.ts')
    expect(result.errors).toHaveBeenCalledOnce()
    expect(result.errors.mock.calls[0][0]).toMatch(
      /Missing setup dependency|must default-export a function|Plugin failed/
    )
    expect(result.mount).not.toHaveBeenCalled()
    expect(result.ready).not.toHaveBeenCalled()
  })
})
