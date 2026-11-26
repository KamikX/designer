import { afterAll, describe, expect, it, vi } from 'vitest'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const state = vi.hoisted(() => ({
  root: `/tmp/designer-library-protocol-${process.pid}-${Math.random().toString(16).slice(2)}`,
  handler: null as null | ((request: { url: string }) => Response),
  selected: true,
  stack: 'react',
  files: [{ path: 'App.tsx', content: 'export default function App() { return null }' }]
}))
vi.mock('../paths', () => ({ DATA_DIR: state.root }))
vi.mock('electron', () => ({
  app: { getAppPath: () => process.cwd() },
  default: { app: { getAppPath: () => process.cwd() } },
  protocol: {
    handle: (_scheme: string, handler: typeof state.handler) => {
      state.handler = handler
    }
  }
}))
vi.mock('../storage/service', () => ({ resolveAsset: vi.fn() }))
vi.mock('../db/repo/artifact', () => ({
  getArtifact: () => ({ id: 'artifact', projectId: 'project' }),
  getArtifactFiles: () => state.files
}))
vi.mock('../db/repo/project', () => ({
  getProject: () => ({
    stack: state.stack,
    libs: [],
    externalLibraries: state.selected ? [{ name: 'protocol-fixture', version: '1.0.0' }] : []
  })
}))
import { libraryId } from '../libraries/service'
import { registerPreviewHandler } from './protocol'
import { registerSessionPreview, unregisterSessionPreview } from './session-registry'
const ref = { name: 'protocol-fixture', version: '1.0.0' }
const id = libraryId(ref)
const root = join(state.root, 'libraries', id)
mkdirSync(join(root, 'dist'), { recursive: true })
writeFileSync(
  join(root, 'library.json'),
  JSON.stringify({
    ...ref,
    id,
    stacks: ['react', 'vue3'],
    description: '',
    instructions: '',
    subpaths: [],
    css: [],
    entries: { 'protocol-fixture': 'entry-0.js' },
    styles: ['style.css'],
    files: ['entry-0.js', 'style.css', 'font.woff2'],
    installedAt: new Date().toISOString()
  })
)
writeFileSync(join(root, 'dist', 'entry-0.js'), 'export const value = 42')
writeFileSync(join(root, 'dist', 'style.css'), '.fixture { color: red }')
writeFileSync(join(root, 'dist', 'font.woff2'), 'font')
registerPreviewHandler()
afterAll(() => rmSync(state.root, { recursive: true, force: true }))
const request = (path: string): Response =>
  state.handler!({ url: `preview://artifact/artifact/${path}` })

describe('project library protocol', () => {
  it('serves selected modules, styles and assets with the correct MIME types', async () => {
    expect(await request(`__libraries__/${id}/entry-0.js`).text()).toContain('value = 42')
    expect(request(`__libraries__/${id}/style.css`).headers.get('content-type')).toContain(
      'text/css'
    )
    expect(request(`__libraries__/${id}/font.woff2`).headers.get('content-type')).toBe('font/woff2')
    expect(request(`__libraries__/${id}/library.json`).status).toBe(404)
    expect(await request('').text()).toContain('protocol-fixture')
  })
  it('does not expose installed packages to projects which did not select them', async () => {
    state.selected = false
    expect(request(`__libraries__/${id}/entry-0.js`).status).toBe(404)
    expect(await request('').text()).not.toContain('protocol-fixture')
    state.selected = true
  })
  it('uses the same dependency selection for the live capture session', async () => {
    registerSessionPreview('capture', {
      stack: 'vue3',
      libs: [],
      externalLibraries: [ref],
      files: () => []
    })
    const response = state.handler!({
      url: `preview://session/capture/__libraries__/${id}/entry-0.js`
    })
    expect(await response.text()).toContain('value = 42')
    unregisterSessionPreview('capture')
  })
  it('discovers optional project setup in persisted artifacts and live sessions', async () => {
    const originalFiles = state.files
    state.stack = 'vue3'
    registerSessionPreview('setup', {
      stack: 'vue3',
      libs: [],
      files: () => state.files
    })
    try {
      for (const paths of [
        [],
        ['app.setup.js'],
        ['app.setup.ts'],
        ['app.setup.js', 'app.setup.ts']
      ]) {
        state.files = paths.map((path) => ({
          path,
          content: 'export default function setup(app: unknown) {}'
        }))
        for (const base of ['preview://artifact/artifact/', 'preview://session/setup/']) {
          const html = await state.handler!({ url: base }).text()
          if (paths.length) {
            const expected = paths.includes('app.setup.ts') ? 'app.setup.ts' : 'app.setup.js'
            expect(html).toContain(`import("./${expected}")`)
            if (expected.endsWith('.ts')) {
              const response = state.handler!({ url: base + expected })
              expect(response.headers.get('content-type')).toContain('javascript')
              expect(await response.text()).not.toContain(': unknown')
            }
          } else {
            expect(html).not.toContain('app.setup.')
          }
        }
      }
      state.stack = 'react'
      expect(await request('').text()).not.toContain('app.setup.')
    } finally {
      state.stack = 'react'
      state.files = originalFiles
      unregisterSessionPreview('setup')
    }
  })
  it('reports a missing installed file through the preview error channel', async () => {
    rmSync(join(root, 'dist', 'entry-0.js'))
    const response = await request('').text()
    expect(response).toContain('reportError(')
    expect(response).toContain('Library files are missing')
  })
})
