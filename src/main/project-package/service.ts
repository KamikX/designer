import { currentLanguage } from '../i18n'
import { text as appText } from '../i18n'
import { and, asc, eq, inArray, gt, sql } from 'drizzle-orm'
import { dialog } from 'electron'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { dirname, join } from 'node:path'
import { monotonicFactory } from 'ulid'
import { z } from 'zod'
import type {
  ProjectPackageExportInput,
  ProjectPackageImportResult,
  SessionSettings
} from '../../shared/types'
import { getDb } from '../db'
import {
  projects,
  conversations,
  messages,
  artifacts,
  artifactFiles,
  assets,
  providers,
  models
} from '../db/schema'
import { getAssetRecord } from '../db/repo/asset'
import {
  metadataSchema,
  exportLibraryFiles,
  importPreparedLibrary,
  resolveLibraries
} from '../libraries/service'
import { readMcpConfig } from '../mcp/config'
import { ASSETS_DIR } from '../paths'
import { scanSkills } from '../skills/scan'
import { resolveAsset } from '../storage/service'
import {
  assetReferences,
  textAsset,
  hash,
  PACKAGE_LIMITS,
  messageSchema,
  conversationSchema,
  projectSchema,
  projectDocumentSchema,
  artifactSchema,
  versionSchema,
  versionDirectory,
  libraryDirectory,
  assetPath,
  readPackage
} from './format'
import type { Manifest, FileInventory } from './format'
import { PackageWriter } from './writer'

function portableSettings(settings: SessionSettings | null): Manifest['project']['settings'] {
  if (!settings) return null
  const db = getDb()
  const provider = settings.providerId
    ? db.select().from(providers).where(eq(providers.id, settings.providerId)).get()
    : null
  const model = settings.modelId
    ? db.select().from(models).where(eq(models.id, settings.modelId)).get()
    : null
  return {
    ...(settings.skillIds !== undefined ? { skillIds: settings.skillIds } : {}),
    ...(settings.mcpIds !== undefined ? { mcpIds: settings.mcpIds } : {}),
    ...(settings.webSearch !== undefined ? { webSearch: settings.webSearch } : {}),
    ...(settings.toolCallLimit !== undefined ? { toolCallLimit: settings.toolCallLimit } : {}),
    model:
      provider && model && model.providerId === provider.id
        ? { providerSlug: provider.slug, modelId: model.modelId }
        : null
  }
}

/** Keep the snapshot consistent while reading bounded batches of source contents into staging. */
export async function buildProjectPackage(input: ProjectPackageExportInput): Promise<Buffer> {
  const request = z
    .object({ projectId: z.string().min(1), selectedArtifactId: z.string().min(1).nullable() })
    .parse(input)
  const writer = new PackageWriter()
  try {
    const db = getDb()
    const snapshot = db.transaction((tx) => {
      const row = tx.select().from(projects).where(eq(projects.id, request.projectId)).get()
      if (!row) throw new Error('Project not found')
      const project = projectSchema.parse({ ...row, settings: portableSettings(row.settings) })
      const cs = tx
        .select()
        .from(conversations)
        .where(eq(conversations.projectId, project.id))
        .all()
      const ms = cs.length
        ? tx
            .select()
            .from(messages)
            .where(
              inArray(
                messages.conversationId,
                cs.map((c) => c.id)
              )
            )
            .orderBy(asc(messages.createdAt), asc(messages.id))
            .all()
        : []
      if (ms.some((m) => m.status === 'streaming'))
        throw new Error(appText('messages.waitForProjectGenerationToFinishBeforeExporting'))
      const versions = tx
        .select()
        .from(artifacts)
        .where(eq(artifacts.projectId, project.id))
        .orderBy(asc(artifacts.version))
        .all()
        .map((v) => artifactSchema.parse(v))
      if (
        (versions.length && !request.selectedArtifactId) ||
        (request.selectedArtifactId && !versions.some((v) => v.id === request.selectedArtifactId))
      )
        throw new Error('Invalid selected project version')
      writer.document('project.json', projectDocumentSchema.parse(project))
      writer.textDocument('STYLE.md', Buffer.from(project.styleBrief, 'utf8'))
      writer.textDocument('DESIGN.md', Buffer.from(project.designDocument, 'utf8'))
      const referencedAssets = assetReferences([project, versions])
      for (const c of cs) {
        const portable = conversationSchema.parse({ ...c, settings: portableSettings(c.settings) })
        writer.document(`conversations/${c.id}/conversation.json`, portable)
        for (const ref of assetReferences(portable)) referencedAssets.add(ref)
      }
      for (const message of ms) {
        const portable = messageSchema.parse({
          ...message,
          parts: JSON.parse(message.parts),
          usage: message.usage ? JSON.parse(message.usage) : null
        })
        writer.document(
          `conversations/${message.conversationId}/messages/${message.id}.json`,
          portable
        )
        for (const ref of assetReferences(portable)) referencedAssets.add(ref)
      }
      const inventories = new Map<string, Map<string, FileInventory>>()
      const fileBatch = tx
        .select()
        .from(artifactFiles)
        .where(
          and(
            eq(artifactFiles.artifactId, sql.placeholder('artifactId')),
            gt(artifactFiles.path, sql.placeholder('after'))
          )
        )
        .orderBy(asc(artifactFiles.path))
        .limit(128)
        .prepare()
      let restoredFiles = 0,
        restoredBytes = 0
      for (const version of versions) {
        const parent = version.baseArtifactId ? inventories.get(version.baseArtifactId) : undefined
        if (version.baseArtifactId && !parent) throw new Error('Invalid project version parent')
        const inventory = new Map<string, FileInventory>()
        const writes: string[] = []
        let after = ''
        while (true) {
          const batch = fileBatch.all({ artifactId: version.id, after })
          if (!batch.length) break
          for (const file of batch) {
            const data = Buffer.from(file.content, 'utf8')
            const meta = {
              id: file.id,
              path: file.path,
              size: data.length,
              sha256: hash(data),
              createdAt: file.createdAt,
              updatedAt: file.updatedAt
            }
            restoredBytes += data.length
            if (
              ++restoredFiles > PACKAGE_LIMITS.restoredFiles ||
              restoredBytes > PACKAGE_LIMITS.restoredBytes
            )
              throw new Error('Restored project exceeds size or file count limit')
            inventory.set(file.path, meta)
            const previous = parent?.get(file.path)
            if (!previous || previous.sha256 !== meta.sha256 || previous.size !== meta.size) {
              writer.write(`${versionDirectory(version.version)}/files/${file.path}`, data)
              writes.push(file.path)
              for (const ref of assetReferences(file.content)) referencedAssets.add(ref)
            }
          }
          after = batch[batch.length - 1].path
        }
        const deleted = parent
          ? [...parent.keys()].filter((path) => !inventory.has(path)).sort()
          : []
        writer.document(
          `${versionDirectory(version.version)}/version.json`,
          versionSchema.parse({ ...version, writes, deleted, files: [...inventory.values()] })
        )
        inventories.set(version.id, inventory)
      }
      return { project, referencedAssets }
    })
    const sourceAssets: Manifest['assets'] = []
    for (const id of snapshot.referencedAssets) {
      const row = getAssetRecord(id)
      const resolved = await resolveAsset(id)
      if (
        !row ||
        !resolved ||
        hash(resolved.data) !== row.sha256 ||
        resolved.data.length !== row.size
      )
        throw new Error(`Missing or corrupt project asset: ${id}`)
      for (const ref of assetReferences(textAsset(resolved.data, row.mime)))
        snapshot.referencedAssets.add(ref)
      const asset = {
        id: row.id,
        mime: row.mime,
        size: row.size,
        sha256: row.sha256,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt
      }
      writer.write(assetPath(asset), resolved.data)
      sourceAssets.push(asset)
    }
    const libraries = resolveLibraries(
      snapshot.project.externalLibraries ?? [],
      snapshot.project.stack,
      snapshot.project.libs ?? []
    )
    for (const library of libraries) {
      const metadata = metadataSchema.strip().parse(library)
      const files = [...exportLibraryFiles(library)]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([path, data]) => ({
          path,
          ...writer.write(`${libraryDirectory(metadata)}/files/${path}`, data)
        }))
      writer.document(`${libraryDirectory(metadata)}/library.json`, { metadata, files })
    }
    return writer.finish(request.selectedArtifactId, sourceAssets)
  } finally {
    writer.dispose()
  }
}

function restoreSettings(
  settings: Manifest['project']['settings'],
  warnings: Set<string>
): SessionSettings | null {
  if (!settings) return null
  const { model, ...result } = settings
  const skills = new Set(scanSkills().map((s) => s.name))
  const servers = readMcpConfig().servers
  for (const key of ['skillIds', 'mcpIds'] as const) {
    if (result[key] !== undefined)
      result[key] = result[key]!.filter((name) => {
        const available =
          key === 'skillIds'
            ? skills.has(name)
            : Object.hasOwn(servers, name) && servers[name].enabled !== false
        if (!available) warnings.add(`${key === 'skillIds' ? 'Skill' : 'MCP'}: ${name}`)
        return available
      })
  }
  if (model) {
    const db = getDb()
    const provider = db.select().from(providers).where(eq(providers.slug, model.providerSlug)).get()
    const available = provider?.enabled
      ? db
          .select()
          .from(models)
          .where(eq(models.providerId, provider.id))
          .all()
          .find((m) => m.enabled && m.modelId === model.modelId && m.type === 'chat')
      : null
    if (available && provider)
      Object.assign(result, { providerId: provider.id, modelId: available.id })
    else warnings.add(`Model: ${model.providerSlug}/${model.modelId}`)
  }
  return result
}

/** All IDs are fresh; imported identities are lookup keys and never update targets. */
export function importProjectPackage(data: Buffer): ProjectPackageImportResult {
  const { manifest: m, readPayload, readText } = readPackage(data, currentLanguage())
  const db = getDb()
  const warnings = new Set<string>()
  const nextId = monotonicFactory()
  const projectId = nextId()
  const mapIds = (rows: { id: string }[]): Map<string, string> =>
    new Map(rows.map((r) => [r.id, nextId()]))
  const cids = mapIds(m.conversations)
  const mids = mapIds(
    [...m.messages].sort(
      (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)
    )
  )
  const aids = mapIds(m.artifacts)
  const assetIds = new Map(m.assets.map((a) => [a.id.toUpperCase(), nextId()]))
  const rewrite = (value: unknown): unknown => {
    if (typeof value === 'string')
      return value.replace(
        /asset:\/\/([a-zA-Z0-9_-]+)/gi,
        (_all, id: string) => `asset://${assetIds.get(id.toUpperCase()) ?? id}`
      )
    if (Array.isArray(value)) return value.map(rewrite)
    if (value && typeof value === 'object')
      return Object.fromEntries(
        Object.entries(value).map(([key, val]) => [
          key,
          key === 'assetId' && typeof val === 'string'
            ? (assetIds.get(val.toUpperCase()) ?? val)
            : rewrite(val)
        ])
      )
    return value
  }
  const projectSettings = restoreSettings(m.project.settings, warnings) ?? {}
  projectSettings.selectedArtifactId = m.selectedArtifactId ? aids.get(m.selectedArtifactId)! : null
  const conversationSettings = new Map(
    m.conversations.map((c) => [c.id, restoreSettings(c.settings, warnings)])
  )
  const names = new Set(
    db
      .select({ name: projects.name })
      .from(projects)
      .all()
      .map((p) => p.name)
  )
  let name = m.project.name
  for (let n = 2; names.has(name); n++) name = `${m.project.name} (${n})`
  const cleanup: (() => void)[] = []
  try {
    mkdirSync(ASSETS_DIR, { recursive: true })
    const assetDir = m.assets.length ? mkdtempSync(join(ASSETS_DIR, 'import-')) : null
    if (assetDir) cleanup.push(() => rmSync(assetDir, { recursive: true, force: true }))
    const assetLocations = new Map<string, string>()
    const assetContents = new Map<string, { size: number; sha256: string }>()
    for (const asset of m.assets) {
      const id = assetIds.get(asset.id.toUpperCase())!
      const path = join(assetDir!, id)
      const original = readPayload(assetPath(asset))
      const text = textAsset(original, asset.mime)
      const bytes = text === null ? original : Buffer.from(rewrite(text) as string, 'utf8')
      assetContents.set(asset.id, { size: bytes.length, sha256: hash(bytes) })
      writeFileSync(path, bytes, { flag: 'wx' })
      assetLocations.set(asset.id, `${assetDir!.slice(ASSETS_DIR.length + 1)}/${id}`)
    }
    for (const lib of m.libraries)
      cleanup.push(
        importPreparedLibrary(
          lib.metadata,
          new Map(
            lib.files.map((f) => [
              f.path,
              readPayload(`${libraryDirectory(lib.metadata)}/files/${f.path}`)
            ])
          )
        )
      )
    resolveLibraries(m.project.externalLibraries ?? [], m.project.stack, m.project.libs ?? [])
    const project = db.transaction((tx) => {
      const row = tx
        .insert(projects)
        .values({
          ...m.project,
          id: projectId,
          name,
          styleBrief: rewrite(m.project.styleBrief) as string,
          designDocument: rewrite(m.project.designDocument) as string,
          description: rewrite(m.project.description) as string,
          codeInstructions: rewrite(m.project.codeInstructions) as string,
          settings: projectSettings
        })
        .returning()
        .get()
      for (const c of m.conversations)
        tx.insert(conversations)
          .values({
            ...c,
            id: cids.get(c.id)!,
            projectId,
            title: rewrite(c.title) as string,
            settings: conversationSettings.get(c.id)
          })
          .run()
      for (const message of m.messages)
        tx.insert(messages)
          .values({
            ...message,
            id: mids.get(message.id)!,
            conversationId: cids.get(message.conversationId)!,
            artifactId: message.artifactId ? aids.get(message.artifactId)! : null,
            parts: JSON.stringify(rewrite(message.parts)),
            usage: message.usage ? JSON.stringify(message.usage) : null
          })
          .run()
      for (const artifact of m.artifacts)
        tx.insert(artifacts)
          .values({
            ...artifact,
            id: aids.get(artifact.id)!,
            projectId,
            summary: rewrite(artifact.summary) as string,
            messageId: artifact.messageId ? mids.get(artifact.messageId)! : null,
            baseArtifactId: artifact.baseArtifactId ? aids.get(artifact.baseArtifactId)! : null
          })
          .run()
      const insertFile = tx
        .insert(artifactFiles)
        .values({
          id: sql.placeholder('id'),
          artifactId: sql.placeholder('artifactId'),
          path: sql.placeholder('path'),
          content: sql.placeholder('content'),
          createdAt: sql.placeholder('createdAt'),
          updatedAt: sql.placeholder('updatedAt')
        })
        .prepare()
      for (const file of m.files)
        insertFile.run({
          id: nextId(),
          artifactId: aids.get(file.artifactId)!,
          path: file.path,
          content: rewrite(readText(file.payload)) as string,
          createdAt: file.createdAt,
          updatedAt: file.updatedAt
        })
      for (const asset of m.assets)
        tx.insert(assets)
          .values({
            id: assetIds.get(asset.id.toUpperCase())!,
            mime: asset.mime,
            size: assetContents.get(asset.id)!.size,
            sha256: assetContents.get(asset.id)!.sha256,
            backend: 'local',
            location: assetLocations.get(asset.id)!,
            createdAt: asset.createdAt,
            updatedAt: asset.updatedAt
          })
          .run()
      return row
    })
    return { project: project as ProjectPackageImportResult['project'], warnings: [...warnings] }
  } catch (error) {
    for (const rollback of cleanup.reverse()) {
      try {
        rollback()
      } catch (cleanupError) {
        console.error('[project-import] Cleanup failed:', cleanupError)
      }
    }
    throw error
  }
}

export async function exportProjectPackage(
  input: ProjectPackageExportInput
): Promise<string | null> {
  const result = await dialog.showSaveDialog({
    title: appText('common.exportProject'),
    defaultPath: 'project.designer.zip',
    filters: [{ name: appText('common.projectPackage'), extensions: ['zip'] }]
  })
  if (result.canceled || !result.filePath) return null
  const data = await buildProjectPackage(input)
  const temporary = mkdtempSync(join(dirname(result.filePath), '.designer-export-'))
  try {
    const file = join(temporary, 'package.zip')
    writeFileSync(file, data, { flag: 'wx' })
    renameSync(file, result.filePath)
  } finally {
    rmSync(temporary, { recursive: true, force: true })
  }
  return result.filePath
}

export async function openProjectPackage(): Promise<ProjectPackageImportResult | null> {
  const result = await dialog.showOpenDialog({
    title: appText('common.importProject'),
    filters: [{ name: appText('common.projectPackage'), extensions: ['zip'] }],
    properties: ['openFile']
  })
  if (result.canceled || !result.filePaths.length) return null
  if (statSync(result.filePaths[0]).size > PACKAGE_LIMITS.compressed)
    throw new Error('Project package exceeds size limit')
  return importProjectPackage(readFileSync(result.filePaths[0]))
}
