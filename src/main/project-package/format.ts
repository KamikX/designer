import AdmZip from 'adm-zip'
import { createHash } from 'node:crypto'
import { inflateRawSync } from 'node:zlib'
import { z } from 'zod'
import { libraryId, metadataSchema } from '../libraries/service'
import { validateVisualGuidance } from '../../shared/visual-guidance'

export const PACKAGE_LIMITS = {
  compressed: 512 * 1024 ** 2,
  expanded: 1024 ** 3,
  entries: 50000,
  restoredBytes: 4 * 1024 ** 3,
  restoredFiles: 250000
}
export const hash = (data: Buffer): string => createHash('sha256').update(data).digest('hex')
const id = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9_-]+$/)
const digest = z.string().regex(/^[a-f0-9]{64}$/)
export const packagePath = z
  .string()
  .min(1)
  .max(1000)
  .refine(
    (p) =>
      !/[\\:]/.test(p) &&
      Array.from(p).every((c) => c.charCodeAt(0) > 31) &&
      !p.split('/').some((s) => !s || s === '.' || s === '..')
  )
const stamps = { createdAt: z.string().min(1), updatedAt: z.string().min(1) }
export const settingsSchema = z.object({
  providerId: id.optional(),
  modelId: z.string().optional(),
  skillIds: z.array(z.string()).optional(),
  mcpIds: z.array(z.string()).optional(),
  webSearch: z.boolean().optional(),
  toolCallLimit: z.int().nonnegative().nullable().optional(),
  selectedArtifactId: id.nullable().optional()
})
const portableSettings = z
  .object({
    ...settingsSchema.omit({ providerId: true, modelId: true, selectedArtifactId: true }).shape,
    model: z.object({ providerSlug: z.string(), modelId: z.string() }).nullable().optional()
  })
  .nullable()
const question = z.object({
  intro: z.string().optional(),
  purpose: z.literal('style-brief').optional(),
  questions: z.array(
    z.object({
      header: z.string(),
      question: z.string(),
      kind: z.enum(['single', 'multiple']),
      options: z.array(z.object({ label: z.string(), description: z.string().optional() })),
      allowCustom: z.boolean().optional()
    })
  ),
  notes: z.object({ label: z.string(), placeholder: z.string().optional() }).optional(),
  secrets: z
    .array(z.object({ key: z.string(), label: z.string(), help: z.string().optional() }))
    .optional()
})
export const partsSchema = z.array(
  z.discriminatedUnion('type', [
    z.object({ type: z.literal('text'), text: z.string() }),
    z.object({ type: z.literal('file'), path: packagePath, action: z.enum(['write', 'delete']) }),
    z.object({
      type: z.literal('image'),
      assetId: id,
      mime: z.string(),
      name: z.string(),
      width: z.number().positive().optional(),
      height: z.number().positive().optional(),
      description: z.string().optional()
    }),
    z.object({
      type: z.literal('question'),
      questionId: id,
      ask: question,
      answer: z
        .object({
          selections: z.array(z.array(z.string())),
          notes: z.string().optional(),
          skipped: z.boolean().optional()
        })
        .nullable()
    })
  ])
)
export const projectSchema = z.object({
  id,
  name: z.string().min(1),
  stack: z.enum(['html', 'vue3', 'react']),
  designMode: z.enum(['design', 'prototype']),
  targets: z.array(z.enum(['mobile', 'web', 'landing', 'admin', 'components'])).nullable(),
  libs: z.array(z.enum(['antdv-next', '@antdv-next/icons'])).nullable(),
  externalLibraries: z.array(z.object({ name: z.string(), version: z.string() })).nullable(),
  description: z.string(),
  styleBrief: z.string(),
  designDocument: z.string(),
  visualStylePriority: z.enum(['styleBrief', 'designDocument']),
  settings: portableSettings,
  ...stamps
})

export const fingerprintSchema = z.object({ size: z.int().nonnegative(), sha256: digest })
const fileSchema = z.object({ id, path: packagePath, ...fingerprintSchema.shape, ...stamps })
export const artifactSchema = z.object({
  id,
  projectId: id,
  messageId: id.nullable(),
  version: z.int().positive(),
  baseArtifactId: id.nullable(),
  summary: z.string(),
  ...stamps
})
export const versionSchema = z.object({
  ...artifactSchema.shape,
  writes: z.array(packagePath),
  deleted: z.array(packagePath),
  files: z.array(fileSchema)
})
export const conversationSchema = z.object({
  id,
  projectId: id,
  title: z.string(),
  kind: z.literal('design'),
  settings: portableSettings,
  ...stamps
})
export const messageSchema = z.object({
  id,
  conversationId: id,
  role: z.enum(['user', 'assistant', 'system']),
  parts: partsSchema,
  status: z.enum(['complete', 'error', 'aborted']),
  usage: z
    .object({ inputTokens: z.number().nonnegative(), outputTokens: z.number().nonnegative() })
    .catchall(z.json())
    .nullable(),
  providerSlug: z.string().nullable(),
  modelId: z.string().nullable(),
  artifactId: id.nullable(),
  author: z.string().nullable(),
  ...stamps
})
export const projectDocumentSchema = projectSchema.omit({ styleBrief: true, designDocument: true })
const assetSchema = z.object({ id, mime: z.string(), ...fingerprintSchema.shape, ...stamps })
export const librarySchema = z.object({
  metadata: metadataSchema,
  files: z.array(z.object({ path: packagePath, ...fingerprintSchema.shape }))
})
const documentSchema = z.object({ path: packagePath, ...fingerprintSchema.shape })
export const manifestSchema = z.strictObject({
  format: z.literal('ai-designer-project-incremental'),
  selectedArtifactId: id.nullable(),
  documents: z.array(documentSchema),
  assets: z.array(assetSchema)
})
export type PackageManifest = z.infer<typeof manifestSchema>
export type VersionDocument = z.infer<typeof versionSchema>
export type FileInventory = VersionDocument['files'][number]
export type RestoredFile = FileInventory & { artifactId: string; payload: string }
export interface Manifest {
  selectedArtifactId: string | null
  project: z.infer<typeof projectSchema>
  conversations: z.infer<typeof conversationSchema>[]
  messages: z.infer<typeof messageSchema>[]
  artifacts: z.infer<typeof artifactSchema>[]
  files: RestoredFile[]
  assets: z.infer<typeof assetSchema>[]
  libraries: z.infer<typeof librarySchema>[]
}

export const versionDirectory = (version: number): string =>
  `versions/v${String(version).padStart(4, '0')}`
export const libraryDirectory = (lib: { name: string; version: string }): string =>
  `libraries/${lib.name}/${lib.version}`
export function assetPath(asset: { id: string; mime: string }): string {
  const extensions: Record<string, string> = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'image/svg+xml': 'svg',
    'image/avif': 'avif',
    'image/x-icon': 'ico',
    'application/pdf': 'pdf',
    'application/json': 'json',
    'text/plain': 'txt',
    'text/css': 'css',
    'text/html': 'html',
    'text/javascript': 'js'
  }
  return `assets/${asset.id}.${extensions[asset.mime] ?? 'bin'}`
}
export function decodeText(bytes: Buffer): string {
  // A BOM is part of the saved source, not a transport marker to discard on restoration.
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
}
export function canonicalJson(value: unknown): Buffer {
  const canonical = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(canonical)
    if (v && typeof v === 'object')
      return Object.fromEntries(
        Object.entries(v)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([k, val]) => [k, canonical(val)])
      )
    return v
  }
  return Buffer.from(JSON.stringify(canonical(value), null, 2) + '\n', 'utf8')
}

/** Reject aliases and file/directory collisions before writing to case-insensitive filesystems. */
export class PackagePaths {
  private seen = new Set<string>()
  private files = new Set<string>()
  private directories = new Set<string>()
  add(path: string, directory = false): void {
    if (!packagePath.safeParse(path).success) throw new Error('Unsafe package entry')
    const key = path.normalize('NFC').toLowerCase()
    const parents = key
      .split('/')
      .slice(0, -1)
      .map((_part, index, parts) => parts.slice(0, index + 1).join('/'))
    if (
      this.seen.has(key) ||
      (!directory && this.directories.has(key)) ||
      this.files.has(key) ||
      parents.some((p) => this.files.has(p))
    )
      throw new Error('Unsafe package entry')
    this.seen.add(key)
    if (directory) this.directories.add(key)
    else this.files.add(key)
    parents.forEach((p) => this.directories.add(p))
  }
}

export function textAsset(bytes: Buffer, mime: string): string | null {
  return mime.startsWith('text/') || mime === 'image/svg+xml' || mime === 'application/json'
    ? decodeText(bytes)
    : null
}

export function assetReferences(value: unknown): Set<string> {
  const result = new Set<string>()
  const visit = (v: unknown): void => {
    if (typeof v === 'string') {
      for (const match of v.matchAll(/asset:\/\/([a-zA-Z0-9_-]+)/gi))
        result.add(match[1].toUpperCase())
    } else if (Array.isArray(v)) v.forEach(visit)
    else if (v && typeof v === 'object') {
      const obj = v as Record<string, unknown>
      if (obj.type === 'image' && typeof obj.assetId === 'string')
        result.add(obj.assetId.toUpperCase())
      Object.values(obj).forEach(visit)
    }
  }
  visit(value)
  return result
}

function unique<T>(rows: T[], key: (row: T) => string): Map<string, T> {
  const map = new Map(rows.map((row) => [key(row), row]))
  if (map.size !== rows.length) throw new Error('Duplicate package identity')
  return map
}

function validateRelationships(m: Manifest): void {
  validateVisualGuidance(m.project)
  if (m.project.targets?.includes('components') && m.project.targets.length > 1)
    throw new Error('Invalid project targets')
  const cs = unique(m.conversations, (v) => v.id)
  const ms = unique(m.messages, (v) => v.id)
  const vs = unique(m.artifacts, (v) => v.id)
  const assets = unique(m.assets, (v) => v.id.toUpperCase())
  unique(m.artifacts, (v) => String(v.version))
  unique(m.files, (v) => v.id)
  unique(m.files, (v) => JSON.stringify([v.artifactId, v.path]))
  unique(m.libraries, (v) => v.metadata.id)
  if (
    (vs.size > 0 && !m.selectedArtifactId) ||
    (m.selectedArtifactId && !vs.has(m.selectedArtifactId))
  )
    throw new Error('Invalid selected version')
  for (const c of cs.values())
    if (c.projectId !== m.project.id) throw new Error('Foreign conversation')
  for (const a of vs.values()) {
    if (
      a.projectId !== m.project.id ||
      (a.messageId && !ms.has(a.messageId)) ||
      (a.baseArtifactId &&
        (!vs.has(a.baseArtifactId) || vs.get(a.baseArtifactId)!.version >= a.version))
    )
      throw new Error('Invalid version relationship')
    if (a.messageId && ms.get(a.messageId)!.artifactId !== a.id)
      throw new Error('Invalid version message')
  }
  for (const message of ms.values()) {
    if (
      !cs.has(message.conversationId) ||
      (message.artifactId &&
        (!vs.has(message.artifactId) ||
          (vs.get(message.artifactId)!.messageId !== null &&
            vs.get(message.artifactId)!.messageId !== message.id)))
    )
      throw new Error('Invalid message relationship')
  }
  for (const f of m.files) if (!vs.has(f.artifactId)) throw new Error('Foreign version file')
  for (const ref of assetReferences([m.project, m.conversations, m.messages, m.artifacts]))
    if (!assets.has(ref)) throw new Error(`Missing asset: ${ref}`)
  const refs = m.project.externalLibraries ?? []
  unique(refs, (v) => v.name)
  if (refs.length !== m.libraries.length || (refs.length && m.project.stack === 'html'))
    throw new Error('Invalid library references')
  for (const lib of m.libraries) {
    if (
      lib.metadata.id !== libraryId(lib.metadata) ||
      ['vue', 'react', 'react-dom', ...(m.project.libs ?? [])].includes(lib.metadata.name) ||
      Object.values(lib.metadata.entries).some((p) => !lib.metadata.files.includes(p)) ||
      lib.metadata.styles.some((p) => !lib.metadata.files.includes(p))
    )
      throw new Error('Invalid library metadata')
    if (
      !refs.some((r) => r.name === lib.metadata.name && r.version === lib.metadata.version) ||
      !lib.metadata.stacks.includes(m.project.stack as 'vue3' | 'react')
    )
      throw new Error('Invalid library reference')
    unique(lib.files, (v) => v.path)
    if (
      lib.files.length !== lib.metadata.files.length ||
      lib.metadata.files.some((p) => !lib.files.some((f) => f.path === p))
    )
      throw new Error('Missing library file')
  }
}

export interface ProjectPackage {
  manifest: Manifest
  readPayload: (path: string) => Buffer
  readText: (path: string) => string
}

/** Parse metadata first, then resolve each version once using immutable payload references. */
export function readPackage(data: Buffer): ProjectPackage {
  if (data.length > PACKAGE_LIMITS.compressed) throw new Error('Project package exceeds size limit')
  const zip = new AdmZip(data)
  const entries = zip.getEntries()
  if (entries.length > PACKAGE_LIMITS.entries) throw new Error('Too many package entries')
  const paths = new PackagePaths()
  const files = new Map<string, AdmZip.IZipEntry>()
  let expanded = 0
  for (const entry of entries) {
    if (((entry.attr >>> 16) & 0xf000) === 0xa000) throw new Error('Unsafe package entry')
    paths.add(entry.isDirectory ? entry.entryName.slice(0, -1) : entry.entryName, entry.isDirectory)
    expanded += entry.header.size
    if (expanded > PACKAGE_LIMITS.expanded) throw new Error('Expanded package exceeds size limit')
    if (!entry.isDirectory) files.set(entry.entryName, entry)
  }
  const bytes = (path: string): Buffer => {
    const entry = files.get(path)
    if (!entry) throw new Error(`Missing package payload: ${path}`)
    // adm-zip omits its inflation cap for a declared size of zero; validate that case explicitly.
    if (entry.header.size === 0) {
      if (entry.header.flags & 1) throw new Error('Encrypted package entries are unsupported')
      const compressed = entry.getCompressedData()
      const empty =
        entry.header.method === 8 ? inflateRawSync(compressed, { maxOutputLength: 1 }) : compressed
      if (![0, 8].includes(entry.header.method) || empty.length || entry.header.crc !== 0)
        throw new Error('Package size mismatch')
      return Buffer.alloc(0)
    }
    const data = entry.getData()
    if (data.length !== entry.header.size) throw new Error('Package size mismatch')
    return data
  }
  const parsed = manifestSchema.safeParse(JSON.parse(decodeText(bytes('manifest.json'))))
  if (!parsed.success) throw new Error(`Invalid project package: ${parsed.error.message}`)
  const header = parsed.data
  unique(header.documents, (d) => d.path)
  const expected = new Set(['manifest.json'])
  const documents = new Map<string, Buffer>()
  const check = (path: string, fingerprint: z.infer<typeof fingerprintSchema>): Buffer => {
    if (expected.has(path)) throw new Error('Duplicate package reference')
    expected.add(path)
    const data = bytes(path)
    if (data.length !== fingerprint.size || hash(data) !== fingerprint.sha256)
      throw new Error(`Package checksum mismatch: ${path}`)
    return data
  }
  for (const doc of header.documents) documents.set(doc.path, check(doc.path, doc))
  const document = (path: string): Buffer => {
    const data = documents.get(path)
    if (!data) throw new Error(`Missing package document: ${path}`)
    documents.delete(path)
    return data
  }
  const json = (path: string): unknown => JSON.parse(decodeText(document(path)))
  const project = projectSchema.parse({
    ...projectDocumentSchema.parse(json('project.json')),
    styleBrief: decodeText(document('STYLE.md')),
    designDocument: decodeText(document('DESIGN.md'))
  })
  const m: Manifest = {
    selectedArtifactId: header.selectedArtifactId,
    project,
    conversations: [],
    messages: [],
    artifacts: [],
    files: [],
    assets: header.assets,
    libraries: []
  }
  const versions: VersionDocument[] = []
  for (const path of [...documents.keys()]) {
    if (/^versions\/v\d+\/version\.json$/.test(path)) {
      const v = versionSchema.parse(json(path))
      if (path !== `${versionDirectory(v.version)}/version.json`)
        throw new Error('Invalid version document path')
      versions.push(v)
    } else if (/^conversations\/[^/]+\/conversation\.json$/.test(path)) {
      const c = conversationSchema.parse(json(path))
      if (path !== `conversations/${c.id}/conversation.json`)
        throw new Error('Invalid conversation document path')
      m.conversations.push(c)
    } else if (/^conversations\/[^/]+\/messages\/[^/]+\.json$/.test(path)) {
      const message = messageSchema.parse(json(path))
      if (path !== `conversations/${message.conversationId}/messages/${message.id}.json`)
        throw new Error('Invalid message document path')
      m.messages.push(message)
    } else if (path.startsWith('libraries/') && path.endsWith('/library.json')) {
      const lib = librarySchema.parse(json(path))
      if (path !== `${libraryDirectory(lib.metadata)}/library.json`)
        throw new Error('Invalid library document path')
      m.libraries.push(lib)
    } else throw new Error(`Unexpected package document: ${path}`)
  }
  unique(versions, (v) => v.id)
  unique(versions, (v) => String(v.version))
  versions.sort((a, b) => a.version - b.version)
  let restoredBytes = 0,
    restoredFiles = 0
  for (const v of versions)
    for (const f of v.files) {
      restoredBytes += f.size
      if (
        restoredBytes > PACKAGE_LIMITS.restoredBytes ||
        ++restoredFiles > PACKAGE_LIMITS.restoredFiles
      )
        throw new Error('Restored project exceeds size or file count limit')
    }
  const assetIds = new Set(m.assets.map((a) => a.id.toUpperCase()))
  const checkTextAssets = (text: string): void => {
    for (const ref of assetReferences(text))
      if (!assetIds.has(ref)) throw new Error(`Missing asset: ${ref}`)
  }
  const resolved = new Map<string, Map<string, RestoredFile>>()
  for (const v of versions) {
    const parent = v.baseArtifactId ? resolved.get(v.baseArtifactId) : undefined
    if (v.baseArtifactId && !parent)
      throw new Error('Missing, cyclic or out-of-order version parent')
    const inventory = unique(v.files, (f) => f.path)
    const writes = new Set(v.writes)
    if (writes.size !== v.writes.length || new Set(v.deleted).size !== v.deleted.length)
      throw new Error('Duplicate version operation')
    const tree = new Map(parent)
    for (const path of v.deleted) {
      if (writes.has(path) || !tree.delete(path)) throw new Error('Invalid version deletion')
    }
    for (const path of v.writes) {
      const meta = inventory.get(path)
      if (!meta) throw new Error('Write is absent from version inventory')
      const payload = `${versionDirectory(v.version)}/files/${path}`
      checkTextAssets(decodeText(check(payload, meta)))
      tree.set(path, { ...meta, artifactId: v.id, payload })
    }
    if (tree.size !== inventory.size) throw new Error('Version inventory mismatch')
    const restored = new Map<string, RestoredFile>()
    const filePaths = new PackagePaths()
    for (const meta of v.files) {
      filePaths.add(meta.path)
      const source = tree.get(meta.path)
      if (!source || source.sha256 !== meta.sha256 || source.size !== meta.size)
        throw new Error('Version inventory mismatch')
      const file = { ...meta, artifactId: v.id, payload: source.payload }
      restored.set(meta.path, file)
      m.files.push(file)
    }
    resolved.set(v.id, restored)
    m.artifacts.push(artifactSchema.parse(v))
  }
  validateRelationships(m)
  for (const asset of m.assets)
    checkTextAssets(textAsset(check(assetPath(asset), asset), asset.mime) ?? '')
  for (const lib of m.libraries)
    for (const f of lib.files) check(`${libraryDirectory(lib.metadata)}/files/${f.path}`, f)
  if (expected.size !== files.size || [...files.keys()].some((p) => !expected.has(p)))
    throw new Error('Unexpected package payload')
  for (const entry of entries.filter((e) => e.isDirectory)) {
    if (![...expected].some((p) => p.startsWith(entry.entryName)))
      throw new Error('Unexpected package directory')
  }
  // Bound decoded content independently of the logical restored size; descendants share archive paths.
  const textCache = new Map<string, { text: string; size: number }>()
  let cachedBytes = 0
  const readPayload = (path: string): Buffer => {
    if (!expected.has(path)) throw new Error('Unknown package payload')
    return bytes(path)
  }
  const readText = (path: string): string => {
    const cached = textCache.get(path)
    if (cached) {
      textCache.delete(path)
      textCache.set(path, cached)
      return cached.text
    }
    const data = readPayload(path)
    const text = decodeText(data)
    if (data.length <= 16 * 1024 ** 2) {
      while (cachedBytes + data.length > 16 * 1024 ** 2 && textCache.size) {
        const first = textCache.keys().next().value!
        cachedBytes -= textCache.get(first)!.size
        textCache.delete(first)
      }
      textCache.set(path, { text, size: data.length })
      cachedBytes += data.length
    }
    return text
  }
  return { manifest: m, readPayload, readText }
}
