import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import AdmZip from 'adm-zip'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { asc, eq, sql } from 'drizzle-orm'
import { MIGRATIONS } from '../db/migrations'
import * as schema from '../db/schema'

const state = vi.hoisted(() => ({
  root: `/tmp/designer-package-test-${process.pid}-${Math.random().toString(16).slice(2)}`,
  failAsset: false,
  skills: ['available'],
  servers: { available: { enabled: true } },
  save: vi.fn(),
  open: vi.fn()
}))
let sqlite: Database.Database
let testDb: BetterSQLite3Database<typeof schema>
vi.mock('../db', () => ({ getDb: () => testDb }))
vi.mock('../db/index', () => ({ getDb: () => testDb }))
vi.mock('../paths', () => ({ DATA_DIR: state.root, ASSETS_DIR: join(state.root, 'assets') }))
vi.mock('../config', () => ({ readConfig: () => ({ lang: 'en-US' }) }))
vi.mock('../skills/scan', () => ({ scanSkills: () => state.skills.map((name) => ({ name })) }))
vi.mock('../mcp/config', () => ({ readMcpConfig: () => ({ servers: state.servers }) }))
vi.mock('electron', () => ({
  default: { app: { getAppPath: () => process.cwd() } },
  dialog: { showSaveDialog: state.save, showOpenDialog: state.open }
}))
vi.mock('../storage/service', () => ({
  resolveAsset: async (id: string) => {
    if (state.failAsset) return null
    const asset = testDb.select().from(schema.assets).where(eq(schema.assets.id, id)).get()
    if (!asset) return null
    return {
      data:
        asset.backend === 's3'
          ? Buffer.from('s3-image')
          : readFileSync(join(state.root, 'assets', asset.location)),
      mime: asset.mime
    }
  }
}))

import {
  buildProjectPackage,
  exportProjectPackage,
  importProjectPackage,
  openProjectPackage
} from './service'
import { canonicalJson, hash, PACKAGE_LIMITS, readPackage } from './format'
import type { PackageManifest, VersionDocument } from './format'
import { getProject, saveProjectSettings, setProjectCodeInstructions } from '../db/repo/project'
import { libraryId } from '../libraries/service'

beforeEach(() => {
  rmSync(state.root, { recursive: true, force: true })
  mkdirSync(join(state.root, 'assets'), { recursive: true })
  sqlite = new Database(':memory:')
  sqlite.pragma('foreign_keys = OFF')
  for (const migration of MIGRATIONS) sqlite.exec(migration)
  sqlite.pragma('foreign_keys = ON')
  testDb = drizzle(sqlite, { schema })
  state.failAsset = false
  state.save.mockReset()
  state.open.mockReset()
})
afterEach(() => {
  sqlite.close()
  rmSync(state.root, { recursive: true, force: true })
})

function seed(): void {
  testDb
    .insert(schema.providers)
    .values({
      id: 'provider',
      slug: 'custom',
      name: 'Custom',
      adapter: 'openai',
      apiKeyCipher: 'SECRET-CANARY'
    })
    .run()
  testDb
    .insert(schema.models)
    .values({
      id: 'model-row',
      providerId: 'provider',
      modelId: 'model-name',
      displayName: 'Model'
    })
    .run()
  testDb
    .insert(schema.projects)
    .values({
      id: 'p',
      name: 'Project',
      stack: 'html',
      description: 'Description',
      codeInstructions: 'Use Zod.\nUse translation keys.',
      styleBrief: 'Minimal',
      designDocument: '# Design',
      visualStylePriority: 'designDocument',
      settings: {
        providerId: 'provider',
        modelId: 'model-row',
        skillIds: ['available', 'missing'],
        mcpIds: ['available', 'missing'],
        toolCallLimit: 0
      }
    })
    .run()
  testDb.insert(schema.conversations).values({ id: 'c', projectId: 'p', kind: 'design' }).run()
  for (let n = 1; n <= 2; n++) {
    testDb
      .insert(schema.messages)
      .values({
        id: `m${n}`,
        conversationId: 'c',
        role: 'assistant',
        artifactId: `a${n}`,
        parts: JSON.stringify([{ type: 'text', text: `Version ${n}` }])
      })
      .run()
    testDb
      .insert(schema.artifacts)
      .values({
        id: `a${n}`,
        projectId: 'p',
        version: n,
        messageId: `m${n}`,
        baseArtifactId: n === 2 ? 'a1' : null
      })
      .run()
    testDb
      .insert(schema.artifactFiles)
      .values({
        id: `f${n}`,
        artifactId: `a${n}`,
        path: 'index.html',
        content: `<h1>Version ${n}</h1>`
      })
      .run()
  }
}
function seedLibrary(): { root: string; bytes: Buffer } {
  const bytes = Buffer.from('export const value = 1')
  const metadata = {
    name: 'fixture',
    version: '1.0.0',
    stacks: ['react'],
    description: 'Fixture',
    instructions: '',
    subpaths: [],
    css: [],
    id: libraryId({ name: 'fixture', version: '1.0.0' }),
    installedAt: '2026-11-24T00:00:00Z',
    entries: { fixture: 'index.js' },
    styles: [],
    files: ['index.js']
  }
  const root = join(state.root, 'libraries', metadata.id)
  mkdirSync(join(root, 'dist'), { recursive: true })
  writeFileSync(join(root, 'library.json'), JSON.stringify(metadata))
  writeFileSync(join(root, 'dist', 'index.js'), bytes)
  testDb
    .update(schema.projects)
    .set({ stack: 'react', externalLibraries: [{ name: 'fixture', version: '1.0.0' }] })
    .where(eq(schema.projects.id, 'p'))
    .run()
  return { root, bytes }
}

function mutate(data: Buffer, change: (m: PackageManifest, zip: AdmZip) => void): Buffer {
  const zip = new AdmZip(data)
  const manifest = JSON.parse(zip.readAsText('manifest.json'))
  change(manifest, zip)
  zip.updateFile('manifest.json', Buffer.from(JSON.stringify(manifest)))
  return zip.toBuffer()
}

function editDocument<T>(data: Buffer, path: string, change: (document: T) => void): Buffer {
  return mutate(data, (manifest, zip) => {
    const doc = JSON.parse(zip.readAsText(path)) as T
    change(doc)
    const bytes = canonicalJson(doc)
    zip.updateFile(path, bytes)
    const descriptor = manifest.documents.find((d) => d.path === path)!
    descriptor.sha256 = hash(bytes)
    descriptor.size = bytes.length
  })
}

// The database and filesystem assertions protect existing projects, beyond validating the wire shape.
describe('project packages', () => {
  it('round trips all versions and history, remaps IDs, and preserves the selected older version', async () => {
    seed()
    const before = testDb.select().from(schema.projects).all()
    const data = await buildProjectPackage({ projectId: 'p', selectedArtifactId: 'a1' })
    const archive = new AdmZip(data)
    expect(
      archive
        .getEntries()
        .map((e) => e.getData().toString())
        .join('')
    ).not.toContain('SECRET-CANARY')
    const imported = importProjectPackage(data)
    expect(imported.project.id).not.toBe('p')
    expect(imported.project.name).toBe('Project (2)')
    expect(imported.project.designDocument).toBe('# Design')
    expect(imported.project.codeInstructions).toBe('Use Zod.\nUse translation keys.')
    expect(imported.project.visualStylePriority).toBe('designDocument')
    expect(imported.project.settings).toMatchObject({
      providerId: 'provider',
      modelId: 'model-row',
      skillIds: ['available'],
      mcpIds: ['available'],
      toolCallLimit: 0
    })
    expect(imported.warnings).toEqual(['Skill: missing', 'MCP: missing'])
    const versions = testDb
      .select()
      .from(schema.artifacts)
      .where(eq(schema.artifacts.projectId, imported.project.id))
      .all()
    expect(versions.map((v) => v.version)).toEqual([1, 2])
    expect(imported.project.settings?.selectedArtifactId).toBe(versions[0].id)
    expect(versions[1].baseArtifactId).toBe(versions[0].id)
    const cs = testDb
      .select()
      .from(schema.conversations)
      .where(eq(schema.conversations.projectId, imported.project.id))
      .all()
    const ms = testDb
      .select()
      .from(schema.messages)
      .where(eq(schema.messages.conversationId, cs[0].id))
      .orderBy(asc(schema.messages.createdAt), asc(schema.messages.id))
      .all()
    expect(ms.map((m) => m.artifactId)).toEqual(versions.map((v) => v.id))
    expect(versions.map((v) => v.messageId)).toEqual(ms.map((m) => m.id))
    expect(testDb.select().from(schema.projects).where(eq(schema.projects.id, 'p')).all()).toEqual(
      before
    )
    expect(importProjectPackage(data).project.name).toBe('Project (3)')
  })

  it('rejects saving another project version as the selection', () => {
    seed()
    testDb.insert(schema.projects).values({ id: 'other', name: 'Other' }).run()
    expect(() => saveProjectSettings('other', { selectedArtifactId: 'a1' })).toThrow('selected')
    expect(
      testDb.select().from(schema.projects).where(eq(schema.projects.id, 'other')).get()!.settings
    ).toBeNull()
    saveProjectSettings('p', { selectedArtifactId: 'a1' })
    expect(
      testDb.select().from(schema.projects).where(eq(schema.projects.id, 'p')).get()!.settings
        ?.selectedArtifactId
    ).toBe('a1')
  })

  it('exports empty projects and restores missing local model choices with a warning', async () => {
    seed()
    testDb.insert(schema.projects).values({ id: 'empty', name: 'Empty' }).run()
    const empty = importProjectPackage(
      await buildProjectPackage({ projectId: 'empty', selectedArtifactId: null })
    )
    expect(empty.project.settings?.selectedArtifactId).toBeNull()
    const data = await buildProjectPackage({ projectId: 'p', selectedArtifactId: 'a1' })
    testDb.delete(schema.models).run()
    const imported = importProjectPackage(data)
    expect(imported.project.settings?.modelId).toBeUndefined()
    expect(imported.warnings).toContain('Model: custom/model-name')
  })

  it('copies local and S3 resources and remaps both file URIs and image parts', async () => {
    seed()
    for (const [id, backend, text] of [
      ['LOCAL', 'local', 'local-image'],
      ['REMOTE', 's3', 's3-image'],
      ['VECTOR', 'local', '<svg><image href="asset://REMOTE" /></svg>']
    ] as const) {
      const bytes = Buffer.from(text)
      if (backend === 'local') writeFileSync(join(state.root, 'assets', id), bytes)
      testDb
        .insert(schema.assets)
        .values({
          id,
          mime: id === 'VECTOR' ? 'image/svg+xml' : 'image/png',
          size: bytes.length,
          sha256: hash(bytes),
          backend,
          location: id
        })
        .run()
    }
    testDb
      .update(schema.artifactFiles)
      .set({ content: '<img src="asset://local"><img src="asset://VECTOR">' })
      .where(eq(schema.artifactFiles.id, 'f1'))
      .run()
    testDb
      .update(schema.messages)
      .set({
        parts: JSON.stringify([
          { type: 'image', assetId: 'LOCAL', mime: 'image/png', name: 'Image' }
        ])
      })
      .where(eq(schema.messages.id, 'm1'))
      .run()
    const data = await buildProjectPackage({ projectId: 'p', selectedArtifactId: 'a1' })
    const imported = importProjectPackage(data)
    const version = testDb
      .select()
      .from(schema.artifacts)
      .where(eq(schema.artifacts.id, imported.project.settings!.selectedArtifactId!))
      .get()!
    const file = testDb
      .select()
      .from(schema.artifactFiles)
      .where(eq(schema.artifactFiles.artifactId, version.id))
      .get()!
    const message = testDb
      .select()
      .from(schema.messages)
      .where(eq(schema.messages.id, version.messageId!))
      .get()!
    const image = JSON.parse(message.parts)[0]
    expect(image.assetId).not.toBe('LOCAL')
    expect(file.content).toContain(`asset://${image.assetId}`)
    const copied = testDb
      .select()
      .from(schema.assets)
      .where(eq(schema.assets.id, image.assetId))
      .get()!
    expect(copied.backend).toBe('local')
    expect(readFileSync(join(state.root, 'assets', copied.location)).toString()).toBe('local-image')
    expect(testDb.select().from(schema.assets).all()).toHaveLength(6)
    const vector = testDb
      .select()
      .from(schema.assets)
      .all()
      .find((a) => a.mime === 'image/svg+xml' && a.id !== 'VECTOR')!
    const vectorBytes = readFileSync(join(state.root, 'assets', vector.location))
    expect(file.content).toContain(`asset://${vector.id}`)
    expect(vectorBytes.toString()).not.toContain('asset://REMOTE')
    expect(vector.sha256).toBe(hash(vectorBytes))
    expect(vector.size).toBe(vectorBytes.length)
  })

  it('fails on a missing asset, a foreign selection, and active generation', async () => {
    seed()
    await expect(
      buildProjectPackage({ projectId: 'p', selectedArtifactId: 'foreign' })
    ).rejects.toThrow('selected')
    testDb
      .update(schema.messages)
      .set({ status: 'streaming' })
      .where(eq(schema.messages.id, 'm1'))
      .run()
    await expect(buildProjectPackage({ projectId: 'p', selectedArtifactId: 'a1' })).rejects.toThrow(
      '生成中'
    )
    testDb
      .update(schema.messages)
      .set({ status: 'complete' })
      .where(eq(schema.messages.id, 'm1'))
      .run()
    testDb
      .update(schema.artifactFiles)
      .set({ content: '<img src="asset://MISSING">' })
      .where(eq(schema.artifactFiles.id, 'f1'))
      .run()
    await expect(buildProjectPackage({ projectId: 'p', selectedArtifactId: 'a1' })).rejects.toThrow(
      'asset'
    )
  })

  it('transfers prepared libraries without overwriting conflicting installed content', async () => {
    seed()
    const { root, bytes } = seedLibrary()
    const data = await buildProjectPackage({ projectId: 'p', selectedArtifactId: 'a1' })
    rmSync(root, { recursive: true })
    importProjectPackage(data)
    expect(readFileSync(join(root, 'dist', 'index.js'))).toEqual(bytes)
    importProjectPackage(data)
    writeFileSync(join(root, 'dist', 'index.js'), 'different content')
    expect(() => importProjectPackage(data)).toThrow('conflict')
    expect(readFileSync(join(root, 'dist', 'index.js'), 'utf8')).toBe('different content')
    expect(testDb.select().from(schema.projects).all()).toHaveLength(3)
  })

  it('rolls back the database and removes only newly copied assets and libraries on failure', async () => {
    seed()
    const bytes = Buffer.from('image')
    writeFileSync(join(state.root, 'assets', 'IMAGE'), bytes)
    testDb
      .insert(schema.assets)
      .values({
        id: 'IMAGE',
        mime: 'image/png',
        size: bytes.length,
        sha256: hash(bytes),
        backend: 'local',
        location: 'IMAGE'
      })
      .run()
    testDb
      .update(schema.artifactFiles)
      .set({ content: 'asset://IMAGE' })
      .where(eq(schema.artifactFiles.id, 'f1'))
      .run()
    const { root } = seedLibrary()
    const data = await buildProjectPackage({ projectId: 'p', selectedArtifactId: 'a1' })
    rmSync(root, { recursive: true })
    sqlite.exec(
      "CREATE TRIGGER reject_import BEFORE INSERT ON messages WHEN NEW.id != 'm1' BEGIN SELECT RAISE(ABORT, 'injected failure'); END"
    )
    expect(() => importProjectPackage(data)).toThrow('injected failure')
    expect(testDb.select().from(schema.projects).all()).toHaveLength(1)
    expect(testDb.select().from(schema.conversations).all()).toHaveLength(1)
    expect(readdirSync(join(state.root, 'assets'))).toEqual(['IMAGE'])
    expect(existsSync(root)).toBe(false)
  })

  it('stores readable increments, follows branches, and restores exact source bytes and metadata', async () => {
    seed()
    testDb.delete(schema.artifactFiles).run()
    const trees = [
      {
        id: 'a1',
        version: 1,
        parent: null,
        files: {
          'index.html': '\ufeff<h1>Žltý kôň</h1>\r\n',
          'keep.css': 'body {}\r\n',
          'old.txt': 'rename me',
          'empty.txt': ''
        }
      },
      {
        id: 'a2',
        version: 2,
        parent: 'a1',
        files: {
          'index.html': '<h1>Changed</h1>\r\n',
          'keep.css': 'body {}\r\n',
          'renamed.txt': 'rename me',
          'empty.txt': ''
        }
      },
      {
        id: 'a3',
        version: 3,
        parent: 'a1',
        files: { 'index.html': '\ufeff<h1>Žltý kôň</h1>\r\n', 'branch.txt': 'branch' }
      },
      {
        id: 'a4',
        version: 4,
        parent: 'a2',
        files: {
          'index.html': '<h1>Changed</h1>\r\n',
          'keep.css': 'body {}\r\n',
          'renamed.txt': 'rename me',
          'empty.txt': '',
          'old.txt': 'back'
        }
      },
      { id: 'a5', version: 5, parent: null, files: { 'root.txt': 'another root' } }
    ]
    for (const tree of trees) {
      if (tree.version > 2)
        testDb
          .insert(schema.artifacts)
          .values({
            id: tree.id,
            projectId: 'p',
            version: tree.version,
            baseArtifactId: tree.parent
          })
          .run()
      for (const [path, content] of Object.entries(tree.files)) {
        testDb
          .insert(schema.artifactFiles)
          .values({
            id: `${tree.id}-f${Object.keys(tree.files).indexOf(path)}`,
            artifactId: tree.id,
            path,
            content: content!,
            createdAt: '2026-11-20 10:00:00',
            updatedAt: `2026-11-24 10:00:0${tree.version}`
          })
          .run()
      }
    }
    const data = await buildProjectPackage({ projectId: 'p', selectedArtifactId: 'a2' })
    const zip = new AdmZip(data)
    expect(zip.getEntries().some((e) => e.entryName.startsWith('blobs/'))).toBe(false)
    expect(zip.readAsText('STYLE.md')).toBe('Minimal')
    expect(zip.readAsText('DESIGN.md')).toBe('# Design')
    const project = JSON.parse(zip.readAsText('project.json'))
    expect(project.styleBrief).toBeUndefined()
    expect(project.designDocument).toBeUndefined()
    const v2 = JSON.parse(zip.readAsText('versions/v0002/version.json')) as VersionDocument
    expect(v2.writes).toEqual(['index.html', 'renamed.txt'])
    expect(v2.deleted).toEqual(['old.txt'])
    expect(zip.getEntry('versions/v0002/files/keep.css')).toBeNull()
    expect(zip.getEntry('versions/v0002/files/empty.txt')).toBeNull()
    const v3 = JSON.parse(zip.readAsText('versions/v0003/version.json')) as VersionDocument
    expect(v3.writes).toEqual(['branch.txt'])
    expect(v3.deleted).toEqual(['empty.txt', 'keep.css', 'old.txt'])
    const imported = importProjectPackage(data)
    const restoredVersions = testDb
      .select()
      .from(schema.artifacts)
      .where(eq(schema.artifacts.projectId, imported.project.id))
      .orderBy(asc(schema.artifacts.version))
      .all()
    expect(restoredVersions).toHaveLength(trees.length)
    expect(imported.project.settings?.selectedArtifactId).toBe(restoredVersions[1].id)
    for (const [i, version] of restoredVersions.entries()) {
      const files = testDb
        .select()
        .from(schema.artifactFiles)
        .where(eq(schema.artifactFiles.artifactId, version.id))
        .all()
      expect(Object.fromEntries(files.map((f) => [f.path, f.content]))).toEqual(trees[i].files)
      expect(
        files.every(
          (f) =>
            f.createdAt === '2026-11-20 10:00:00' &&
            f.updatedAt === `2026-11-24 10:00:0${version.version}`
        )
      ).toBe(true)
      expect(version.baseArtifactId).toBe(
        trees[i].parent
          ? restoredVersions.find(
              (v) => v.version === trees.find((t) => t.id === trees[i].parent)!.version
            )!.id
          : null
      )
    }
  })

  it('exports stable documents and changes only the manifest when selecting another version', async () => {
    seed()
    const exportAs = async (selectedArtifactId: string): Promise<Map<string, string>> => {
      const zip = new AdmZip(await buildProjectPackage({ projectId: 'p', selectedArtifactId }))
      return new Map(zip.getEntries().map((e) => [e.entryName, e.getData().toString('base64')]))
    }
    const first = await exportAs('a1')
    expect(await exportAs('a1')).toEqual(first)
    const selection = await exportAs('a2')
    expect(selection.get('manifest.json')).not.toBe(first.get('manifest.json'))
    for (const [path, bytes] of first)
      if (path !== 'manifest.json') expect(selection.get(path)).toBe(bytes)
    testDb
      .insert(schema.artifacts)
      .values({ id: 'a3', projectId: 'p', version: 3, baseArtifactId: 'a2' })
      .run()
    testDb
      .insert(schema.artifactFiles)
      .values({ id: 'f3', artifactId: 'a3', path: 'new.html', content: 'new' })
      .run()
    const next = await exportAs('a1')
    for (const [path, bytes] of first)
      if (path.startsWith('versions/')) expect(next.get(path)).toBe(bytes)
    const zip = new AdmZip(await buildProjectPackage({ projectId: 'p', selectedArtifactId: 'a1' }))
    expect(zip.readAsText('versions/v0001/version.json')).toBe(
      canonicalJson(JSON.parse(zip.readAsText('versions/v0001/version.json'))).toString()
    )
  })

  it('counts inherited contents towards restored limits before any writes', async () => {
    seed()
    testDb.update(schema.artifactFiles).set({ content: 'same' }).run()
    const data = await buildProjectPackage({ projectId: 'p', selectedArtifactId: 'a1' })
    expect(new AdmZip(data).getEntry('versions/v0002/files/index.html')).toBeNull()
    for (const [key, value] of [
      ['restoredBytes', 7],
      ['restoredFiles', 1]
    ] as const) {
      const old = PACKAGE_LIMITS[key]
      PACKAGE_LIMITS[key] = value
      try {
        expect(() => importProjectPackage(data)).toThrow('Restored')
        await expect(
          buildProjectPackage({ projectId: 'p', selectedArtifactId: 'a1' })
        ).rejects.toThrow('Restored')
      } finally {
        PACKAGE_LIMITS[key] = old
      }
    }
    expect(testDb.select().from(schema.projects).all()).toHaveLength(1)
    expect(readdirSync(join(state.root, 'assets'))).toEqual([])
  })

  it('rejects conflicting or incomplete inherited inventories and unsafe payloads', async () => {
    seed()
    testDb.update(schema.artifactFiles).set({ content: 'same' }).run()
    const data = await buildProjectPackage({ projectId: 'p', selectedArtifactId: 'a1' })
    const changed = (fn: (v: VersionDocument) => void): Buffer =>
      editDocument<VersionDocument>(data, 'versions/v0002/version.json', fn)
    for (const invalid of [
      changed((v) => {
        v.files[0].sha256 = '0'.repeat(64)
      }),
      changed((v) => {
        v.files[0].path = 'missing.html'
      }),
      changed((v) => {
        v.deleted = ['index.html']
      }),
      changed((v) => {
        v.files = []
      }),
      changed((v) => {
        v.deleted = ['index.html', 'index.html']
      }),
      changed((v) => {
        v.files.push({ ...v.files[0], id: 'alias', path: 'index.html/nested' })
      })
    ])
      expect(() => importProjectPackage(invalid)).toThrow()
    const aliases = new AdmZip(data)
    aliases.addFile('versions/v0001/files/INDEX.HTML', Buffer.from('alias'))
    expect(() => readPackage(aliases.toBuffer())).toThrow('Unsafe')
    const collision = new AdmZip(data)
    collision.addFile('versions/v0001/files/index.html/nested', Buffer.from('nested'))
    expect(() => readPackage(collision.toBuffer())).toThrow('Unsafe')
    const invalidUtf8 = new AdmZip(data)
    const invalidBytes = Buffer.from([0xff])
    invalidUtf8.updateFile('versions/v0001/files/index.html', invalidBytes)
    let malformed = invalidUtf8.toBuffer()
    for (const n of [1, 2])
      malformed = editDocument<VersionDocument>(
        malformed,
        `versions/v000${n}/version.json`,
        (v) => {
          Object.assign(v.files[0], { size: 1, sha256: hash(invalidBytes) })
        }
      )
    expect(() => readPackage(malformed)).toThrow()
    expect(() => readPackage(new AdmZip().toBuffer())).toThrow()
  })

  it('restores 100 versions with 1000 files each using shared payload references', async () => {
    testDb.insert(schema.projects).values({ id: 'large', name: 'Large' }).run()
    const insertVersion = sqlite.prepare(
      'INSERT INTO artifacts (id, project_id, version, base_artifact_id) VALUES (?, ?, ?, ?)'
    )
    const insertFile = sqlite.prepare(
      'INSERT INTO artifact_files (id, artifact_id, path, content) VALUES (?, ?, ?, ?)'
    )
    sqlite.transaction(() => {
      for (let n = 1; n <= 100; n++) {
        insertVersion.run(`v${n}`, 'large', n, n === 1 ? null : `v${n - 1}`)
        for (let f = 0; f < 1000; f++)
          insertFile.run(
            `v${n}f${f}`,
            `v${n}`,
            `src/file${String(f).padStart(4, '0')}.txt`,
            f === 0 ? `revision ${n}` : `file ${f}`
          )
      }
    })()
    const data = await buildProjectPackage({ projectId: 'large', selectedArtifactId: 'v50' })
    const zip = new AdmZip(data)
    expect(zip.getEntries().filter((e) => e.entryName.includes('/files/'))).toHaveLength(1099)
    const restored = readPackage(data)
    expect(restored.manifest.files).toHaveLength(100000)
    expect(restored.manifest.artifacts).toHaveLength(100)
    expect(
      new Set(
        restored.manifest.files.filter((f) => f.path === 'src/file0001.txt').map((f) => f.payload)
      )
    ).toEqual(new Set(['versions/v0001/files/src/file0001.txt']))
    const imported = importProjectPackage(data)
    const count = testDb
      .select({ n: sql<number>`count(*)` })
      .from(schema.artifactFiles)
      .innerJoin(schema.artifacts, eq(schema.artifacts.id, schema.artifactFiles.artifactId))
      .where(eq(schema.artifacts.projectId, imported.project.id))
      .get()!.n
    expect(count).toBe(100000)
    const selected = testDb
      .select()
      .from(schema.artifacts)
      .where(eq(schema.artifacts.id, imported.project.settings!.selectedArtifactId!))
      .get()!
    expect(selected.version).toBe(50)
  }, 60000)

  it('rejects malformed metadata, relationships, payloads, and checksums before writing', async () => {
    seed()
    const data = await buildProjectPackage({ projectId: 'p', selectedArtifactId: 'a1' })
    const changeVersion = (change: (v: VersionDocument) => void): Buffer =>
      editDocument<VersionDocument>(data, 'versions/v0002/version.json', change)
    const invalid = [
      mutate(data, (m) => {
        m.selectedArtifactId = 'missing'
      }),
      mutate(data, (_m, zip) => {
        zip.deleteFile('versions/v0001/files/index.html')
      }),
      mutate(data, (_m, zip) => {
        zip.updateFile('versions/v0001/files/index.html', Buffer.from('tampered'))
      }),
      mutate(data, (_m, zip) => {
        zip.updateFile('project.json', Buffer.from('{}'))
      }),
      mutate(data, (_m, zip) => {
        zip.addFile('extra.txt', Buffer.from('extra'))
      }),
      changeVersion((v) => {
        v.projectId = 'foreign'
      }),
      changeVersion((v) => {
        v.baseArtifactId = v.id
      }),
      changeVersion((v) => {
        v.baseArtifactId = 'missing'
      }),
      changeVersion((v) => {
        v.files[0].path = '../escape'
      }),
      changeVersion((v) => {
        v.files.push(v.files[0])
      }),
      changeVersion((v) => {
        v.writes = []
      }),
      changeVersion((v) => {
        v.deleted = ['missing.html']
      }),
      changeVersion((v) => {
        v.deleted = ['index.html']
      }),
      changeVersion((v) => {
        v.files[0].sha256 = '0'.repeat(64)
      }),
      changeVersion((v) => {
        v.files = []
      }),
      changeVersion((v) => {
        v.writes.push('index.html')
      }),
      editDocument<{ conversationId: string }>(data, 'conversations/c/messages/m1.json', (m) => {
        m.conversationId = 'missing'
      })
    ]
    for (const bytes of invalid) expect(() => importProjectPackage(bytes)).toThrow()
    expect(testDb.select().from(schema.projects).all()).toHaveLength(1)
    expect(readdirSync(join(state.root, 'assets'))).toEqual([])
  })

  it('rejects unsafe zip paths, symlinks and expanded-size limits', async () => {
    seed()
    const data = await buildProjectPackage({ projectId: 'p', selectedArtifactId: 'a1' })
    for (const name of ['../escape', '/absolute', 'C:\\escape']) {
      const zip = new AdmZip(data)
      zip.addFile('unsafe', Buffer.from('x'))
      zip.getEntry('unsafe')!.entryName = name
      expect(() => readPackage(zip.toBuffer())).toThrow('Unsafe')
    }
    const zip = new AdmZip(data)
    zip.addFile('link', Buffer.from('../target'))
    zip.getEntry('link')!.attr = (0xa1ff * 65536) >>> 0
    expect(() => readPackage(zip.toBuffer())).toThrow('Unsafe')
    const duplicates = new AdmZip(data)
    duplicates.addFile('duplicate', Buffer.from('{}'))
    duplicates.getEntry('duplicate')!.entryName = 'manifest.json'
    expect(() => readPackage(duplicates.toBuffer())).toThrow('Unsafe')
    for (const limit of ['compressed', 'entries'] as const) {
      const original = PACKAGE_LIMITS[limit]
      PACKAGE_LIMITS[limit] = 1
      try {
        expect(() => readPackage(data)).toThrow()
      } finally {
        PACKAGE_LIMITS[limit] = original
      }
    }
    const original = PACKAGE_LIMITS.expanded
    PACKAGE_LIMITS.expanded = 1
    try {
      expect(() => readPackage(data)).toThrow('size limit')
    } finally {
      PACKAGE_LIMITS.expanded = original
    }
  })

  it('cancels dialogs without writing and exports a complete saved ZIP', async () => {
    state.save.mockResolvedValue({ canceled: true })
    state.open.mockResolvedValue({ canceled: true, filePaths: [] })
    expect(
      await exportProjectPackage({ projectId: 'missing', selectedArtifactId: null })
    ).toBeNull()
    expect(await openProjectPackage()).toBeNull()
    seed()
    const path = join(state.root, 'project.zip')
    state.save.mockResolvedValue({ canceled: false, filePath: path })
    expect(await exportProjectPackage({ projectId: 'p', selectedArtifactId: 'a1' })).toBe(path)
    expect(existsSync(path)).toBe(true)
    state.open.mockResolvedValue({ canceled: false, filePaths: [path] })
    expect((await openProjectPackage())!.project.name).toBe('Project (2)')
    expect(readdirSync(state.root).filter((p) => p.startsWith('.designer-export'))).toEqual([])
  })
})

it('imports legacy packages without code instructions with an empty default', async () => {
  seed()
  const zip = new AdmZip(await buildProjectPackage({ projectId: 'p', selectedArtifactId: 'a1' }))
  const document = JSON.parse(zip.readAsText('project.json'))
  delete document.codeInstructions
  zip.updateFile('project.json', Buffer.from(JSON.stringify(document)))
  const manifest = JSON.parse(zip.readAsText('manifest.json'))
  const bytes = zip.getEntry('project.json')!.getData()
  const descriptor = manifest.documents.find(
    (entry: { path: string }) => entry.path === 'project.json'
  )
  descriptor.sha256 = hash(bytes)
  descriptor.size = bytes.length
  zip.updateFile('manifest.json', Buffer.from(JSON.stringify(manifest)))
  expect(importProjectPackage(zip.toBuffer()).project.codeInstructions).toBe('')
})

it('persists and clears code instructions without changing another project or visual guidance', () => {
  seed()
  testDb.insert(schema.projects).values({ id: 'other', name: 'Other' }).run()
  expect(getProject('other')?.codeInstructions).toBe('')
  setProjectCodeInstructions('p', 'Use Zod.\nLocalize labels.')
  expect(getProject('p')?.codeInstructions).toBe('Use Zod.\nLocalize labels.')
  expect(getProject('p')?.designDocument).toBe('# Design')
  expect(getProject('other')?.codeInstructions).toBe('')
  setProjectCodeInstructions('p', '')
  expect(getProject('p')?.codeInstructions).toBe('')
})

it('migrates existing projects to empty instructions without changing saved visual guidance', () => {
  const legacy = new Database(':memory:')
  try {
    for (const migration of MIGRATIONS.slice(0, -1)) legacy.exec(migration)
    legacy
      .prepare('INSERT INTO projects (id, name, style_brief) VALUES (?, ?, ?)')
      .run('legacy', 'Legacy', 'Warm neutrals')
    legacy.exec(MIGRATIONS.at(-1)!)
    expect(legacy.prepare('SELECT code_instructions, style_brief FROM projects').get()).toEqual({
      code_instructions: '',
      style_brief: 'Warm neutrals'
    })
  } finally {
    legacy.close()
  }
})
