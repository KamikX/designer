import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const state = vi.hoisted(() => ({
  root: `/tmp/designer-libraries-test-${process.pid}-${Math.random().toString(16).slice(2)}`,
  fail: false,
  options: {} as Record<string, unknown>,
  unsupported: false,
  optional: false,
  undeclared: false,
  additions: [] as string[][]
}))
vi.mock('../paths', () => ({ DATA_DIR: state.root }))
vi.mock('electron', () => ({ default: { app: { getAppPath: () => process.cwd() } } }))
vi.mock('@npmcli/arborist', () => ({
  default: class {
    constructor(options: Record<string, unknown>) {
      state.options = options
    }
    async reify(options?: { add?: string[] }): Promise<void> {
      if (options?.add) state.additions.push(options.add)
      if (state.fail) throw new Error('Registry unavailable')
      const root = state.options.path as string
      const pkg = join(root, 'node_modules', 'preview-fixture')
      mkdirSync(pkg, { recursive: true })
      writeFileSync(join(root, 'package-lock.json'), '{"lockfileVersion":3}')
      writeFileSync(
        join(pkg, 'package.json'),
        JSON.stringify({
          name: 'preview-fixture',
          ...(state.optional
            ? {
                peerDependencies: { 'peer-fixture': '^1.0.0', 'unused-peer': '^9.0.0' },
                peerDependenciesMeta: {
                  'peer-fixture': { optional: true },
                  'unused-peer': { optional: true }
                }
              }
            : {}),
          type: 'module',
          exports: { '.': './index.js', './sub': './sub.js' }
        })
      )
      writeFileSync(join(pkg, 'shared.js'), 'export const shared = { value: 1 }')
      writeFileSync(
        join(pkg, 'index.js'),
        'import React from "react"; import { jsx } from "react/jsx-runtime"; export { shared } from "./shared.js"; export const react = React; export const render = jsx;'
      )
      writeFileSync(join(pkg, 'sub.js'), 'export { shared } from "./shared.js"')
      if (state.optional)
        writeFileSync(
          join(pkg, 'index.js'),
          'import { merged } from "peer-fixture/sub"; export const result = merged;'
        )
      if (state.undeclared)
        writeFileSync(
          join(pkg, 'index.js'),
          'import value from "undeclared-package"; export default value;'
        )
      if (options?.add?.includes('peer-fixture@^1.0.0')) {
        const peer = join(root, 'node_modules', 'peer-fixture')
        mkdirSync(peer, { recursive: true })
        writeFileSync(
          join(peer, 'package.json'),
          JSON.stringify({ name: 'peer-fixture', type: 'module', exports: { './sub': './sub.js' } })
        )
        writeFileSync(join(peer, 'sub.js'), 'export const merged = "optional peer resolved"')
      }

      if (state.unsupported)
        writeFileSync(join(pkg, 'index.js'), 'import fs from "node:fs"; export default fs')
      writeFileSync(
        join(pkg, 'style.css'),
        '.fixture { background: url(./image.svg); color: red; }'
      )
      writeFileSync(join(pkg, 'image.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>')
    }
  }
}))

import {
  installLibrary,
  installSchema,
  libraryFile,
  libraryId,
  libraryPrompt,
  listLibraries,
  removeLibrary,
  resolveLibraries,
  updateLibrary
} from './service'
import { buildBootstrapHtml } from '../preview/bootstrap'
import type { InstallLibraryInput } from '../../shared/types'

const input = (version = '1.0.0'): InstallLibraryInput => ({
  name: 'preview-fixture',
  version,
  stacks: ['vue3', 'react'],
  description: 'Fixture library',
  instructions: 'Use shared for state.',
  subpaths: ['preview-fixture/sub'],
  css: ['style.css']
})
beforeEach(() => {
  rmSync(state.root, { recursive: true, force: true })
  state.fail = false
  state.unsupported = false
  state.optional = false
  state.undeclared = false
  state.additions = []
})
afterAll(() => rmSync(state.root, { recursive: true, force: true }))

describe('offline project libraries', () => {
  it('rejects version ranges, traversal, unrelated subpaths and reserved runtimes', async () => {
    expect(installSchema.safeParse({ ...input(), version: '^1.0.0' }).success).toBe(false)
    expect(installSchema.safeParse({ ...input(), css: ['../secret'] }).success).toBe(false)
    expect(installSchema.safeParse({ ...input(), subpaths: ['other/sub'] }).success).toBe(false)
    await expect(installLibrary({ ...input(), name: 'react', subpaths: [] })).rejects.toThrow(
      'built-in'
    )
  })
  it('installs exact versions independently, bundles shared chunks/CSS/assets and preserves the framework singleton', async () => {
    const events: string[] = []
    const first = await installLibrary(input(), (e) => events.push(e.stage))
    await installLibrary(input('2.0.0'))
    expect(events).toEqual(['installing', 'building', 'ready'])
    expect(state.options).toMatchObject({
      ignoreScripts: true,
      binLinks: false,
      registry: 'https://registry.npmjs.org'
    })
    expect(listLibraries()).toHaveLength(2)
    expect(first.ready).toBe(true)
    expect(existsSync(join(state.root, 'libraries', first.id, 'package-lock.json'))).toBe(true)
    const js = readFileSync(libraryFile(first, first.entries['preview-fixture']), 'utf8')
    expect(js).toContain('from "react"')
    expect(js).toContain('from "react/jsx-runtime"')
    expect(js).toContain('./chunk-')
    expect(first.styles).toContain('style-0.css')
    expect(
      readdirSync(join(state.root, 'libraries', first.id, 'dist')).some((p) => p.endsWith('.svg'))
    ).toBe(true)
    for (const stack of ['vue3', 'react'] as const) {
      const html = buildBootstrapHtml(stack, '', [], resolveLibraries([input()], stack))
      expect(html).toContain(`./__libraries__/${first.id}/entry-0.js`)
      expect(html).toContain('preview-fixture/sub')
      expect(html).toContain('style-0.css')
    }
    expect(buildBootstrapHtml('react')).not.toContain('preview-fixture')
    expect(() => libraryFile(first, '../../library.json')).toThrow('Invalid library path')
  })
  it('keeps only selected library instructions in prompts and blocks duplicate/incompatible references', async () => {
    await installLibrary(input())
    const prompt = libraryPrompt([input()], 'react')
    expect(prompt).toContain('preview-fixture@1.0.0')
    expect(prompt).toContain('Use shared for state.')
    expect(libraryPrompt([], 'react')).toBe('')
    expect(() => resolveLibraries([input(), input('2.0.0')], 'react')).toThrow('Duplicate')
    expect(() => resolveLibraries([input()], 'html')).toThrow('Vue or React')
    updateLibrary(input(), { description: 'New description', instructions: 'New usage' })
    expect(libraryPrompt([input()], 'vue3')).toContain('New usage')
    expect(() => resolveLibraries([input('2.0.0')], 'react')).toThrow('not installed')
  })
  it('blocks uninstall while referenced and reports missing files without substituting another version', async () => {
    const lib = await installLibrary(input())
    expect(() =>
      removeLibrary(input(), [{ name: 'Dashboard', externalLibraries: [input()] }])
    ).toThrow('Dashboard')
    rmSync(libraryFile(lib, lib.entries['preview-fixture']))
    expect(listLibraries()[0].ready).toBe(false)
    expect(() => resolveLibraries([input()], 'react')).toThrow('missing')
    const repaired = await installLibrary(input())
    expect(repaired.ready).toBe(true)
    removeLibrary(input(), [])
    expect(listLibraries()).toEqual([])
  })
  it('does not publish failed or interrupted installs', async () => {
    state.fail = true
    await expect(installLibrary(input())).rejects.toThrow('Registry unavailable')
    expect(listLibraries()).toEqual([])
    expect(readdirSync(join(state.root, 'libraries'))).toEqual([])
    const temp = join(state.root, 'libraries', `.install-${libraryId(input())}`)
    mkdirSync(temp)
    writeFileSync(join(temp, 'library.json'), '{}')
    expect(listLibraries()).toEqual([])
  })
  it('rejects Node-only packages without publishing a partial installation', async () => {
    state.unsupported = true
    await expect(installLibrary(input())).rejects.toThrow('node:fs')
    expect(listLibraries()).toEqual([])
  })
  it('installs imported optional peers using their declared range, including subpath imports', async () => {
    state.optional = true
    const stages: string[] = []
    const lib = await installLibrary(input(), (event) => stages.push(event.stage))
    expect(state.additions).toEqual([['peer-fixture@^1.0.0']])
    expect(stages).toEqual(['installing', 'building', 'installing', 'building', 'ready'])
    expect(lib.ready).toBe(true)
    expect(readFileSync(libraryFile(lib, lib.entries['preview-fixture']), 'utf8')).toContain(
      'optional peer resolved'
    )
    expect(state.options).toMatchObject({ ignoreScripts: true, binLinks: false })
  })
  it('does not download undeclared imports or unused optional peers', async () => {
    state.optional = true
    state.undeclared = true
    await expect(installLibrary(input())).rejects.toThrow('undeclared-package')
    expect(state.additions).toEqual([])
    expect(listLibraries()).toEqual([])
  })
})
