import { describe, expect, it } from 'vitest'
import { buildBootstrapHtml, injectHtmlRuntime } from './bootstrap'
import { libSetupSource } from './lib-setup'

/**
 * Library setup needs import mappings, CSS loading, and app.use registration together.
 * Missing any part can break previews only for projects selecting that library,
 * so these tests protect against regressions that other projects would not expose.
 */

describe('buildBootstrapHtml component library setup', () => {
  it('Vue 3 with antdv-next includes import mappings and virtual setup', () => {
    const out = buildBootstrapHtml('vue3', undefined, ['antdv-next'])
    expect(out).toContain('"antdv-next":')
    expect(out).toContain('/dist/antd.esm.js')
    // Virtual setup keeps library initialization under host control.
    expect(out).toContain('./__setup__/antdv-next.js')
    // Prefix mappings allow locale and other package subpaths to resolve.
    expect(out).toContain('"antdv-next/":')
  })

  it('virtual setup checks stylesheet loading and installs only selected libraries', () => {
    const code = libSetupSource('antdv-next.js', ['antdv-next'], 'en-US')
    expect(code).toContain('/dist/reset.css')
    expect(code).toContain('/dist/antd.css')
    expect(code).toContain('app.use(Antd)')
    expect(code).toContain('Stylesheet failed to load:')
    // Unselected libraries must not expose their setup modules.
    expect(libSetupSource('antdv-next.js', [])).toBeNull()
    expect(libSetupSource('unknown.js', ['antdv-next'])).toBeNull()
  })

  it('icons add mappings without CSS or plugin registration', () => {
    const out = buildBootstrapHtml('vue3', undefined, ['@antdv-next/icons'])
    expect(out).toContain('/dist/antd-icons.esm.js')
    expect(out).not.toContain('antd.css')
    expect(out).not.toContain('app.use')
  })

  it('projects without libraries retain runtime checks without library setup', () => {
    const out = buildBootstrapHtml('vue3', undefined, [], [], 'en-US')
    // An unselected library must not contribute imports, styles, or registration.
    expect(out).not.toContain('antd.esm.js')
    expect(out).not.toContain('antd.css')
    expect(out).not.toContain('app.use')
    // Unregistered a-* components need actionable errors instead of silent degradation.
    expect(out).toContain('antdv-next is not enabled for this project')
  })

  it('React ignores Vue-only component library selections', () => {
    const out = buildBootstrapHtml('react', undefined, ['antdv-next'])
    expect(out).not.toContain('antdv-next')
  })

  it('library versions are pinned rather than latest', () => {
    const out = buildBootstrapHtml('vue3', undefined, ['antdv-next', '@antdv-next/icons'])
    expect(out).not.toContain('@latest')
  })
})

/**
 * All three stacks need the annotation runtime. Missing injection would make
 * annotation controls silently unresponsive for the affected stack.
 */
describe('annotation runtime injection', () => {
  it.each(['vue3', 'react'] as const)('%s bootstrap includes the annotation runtime', (stack) => {
    const out = buildBootstrapHtml(stack)
    expect(out).toContain("__previewCmd === 'annotate'")
    expect(out).toContain('annotate:pick')
  })

  it('HTML files receive the same annotation runtime', () => {
    const out = injectHtmlRuntime('<html><head></head><body>x</body></html>')
    expect(out).toContain("__previewCmd === 'annotate'")
  })
})
