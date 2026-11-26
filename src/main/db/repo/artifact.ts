import { text } from '../../i18n'
import { asc, desc, eq, sql } from 'drizzle-orm'
import type { Artifact, ArtifactFile } from '../../../shared/types'
import { getDb } from '../index'
import { artifactFiles, artifacts, messages, projects } from '../schema'
import type { ArtifactRow } from '../schema'

/**
 * 设计稿版本仓储。
 *
 * 每个版本存完整文件树:创建新版本时把父版本未变的文件行复制过来,
 * 版本切换 = 一次查询,不用回放 delta 链。
 */

function toView(row: ArtifactRow): Artifact {
  return {
    id: row.id,
    projectId: row.projectId,
    messageId: row.messageId,
    version: row.version,
    baseArtifactId: row.baseArtifactId,
    summary: row.summary,
    createdAt: row.createdAt
  }
}

export function listArtifacts(projectId: string): Artifact[] {
  return getDb()
    .select()
    .from(artifacts)
    .where(eq(artifacts.projectId, projectId))
    .orderBy(desc(artifacts.version))
    .all()
    .map(toView)
}

export function latestArtifact(projectId: string): Artifact | null {
  const row = getDb()
    .select()
    .from(artifacts)
    .where(eq(artifacts.projectId, projectId))
    .orderBy(desc(artifacts.version))
    .limit(1)
    .get()
  return row ? toView(row) : null
}

export function getArtifact(id: string): Artifact | null {
  const row = getDb().select().from(artifacts).where(eq(artifacts.id, id)).get()
  return row ? toView(row) : null
}

export function getArtifactFiles(artifactId: string): ArtifactFile[] {
  return getDb()
    .select({ path: artifactFiles.path, content: artifactFiles.content })
    .from(artifactFiles)
    .where(eq(artifactFiles.artifactId, artifactId))
    .orderBy(asc(artifactFiles.path))
    .all()
}

export function createArtifactVersion(input: {
  projectId: string
  messageId: string | null
  baseArtifactId: string | null
  writes: Map<string, string>
  deletes: Set<string>
  summary: string
}): Artifact {
  const db = getDb()

  // 合并:新写入的文件优先;父版本文件除被删除/被覆盖外全部继承
  const merged = new Map<string, string>()
  if (input.baseArtifactId) {
    for (const f of getArtifactFiles(input.baseArtifactId)) {
      if (!input.deletes.has(f.path) && !input.writes.has(f.path)) merged.set(f.path, f.content)
    }
  }
  for (const [path, content] of input.writes) merged.set(path, content)

  return db.transaction((tx) => {
    // version 取当前最大值 +1;主进程单线程处理 IPC,无并发竞争
    const maxVersion =
      tx
        .select({ v: sql<number>`COALESCE(MAX(${artifacts.version}), 0)` })
        .from(artifacts)
        .where(eq(artifacts.projectId, input.projectId))
        .get()?.v ?? 0

    const artifact = tx
      .insert(artifacts)
      .values({
        projectId: input.projectId,
        messageId: input.messageId,
        version: maxVersion + 1,
        baseArtifactId: input.baseArtifactId,
        summary: input.summary
      })
      .returning()
      .get()

    for (const [path, content] of merged) {
      tx.insert(artifactFiles).values({ artifactId: artifact.id, path, content }).run()
    }

    return toView(artifact)
  })
}

export function saveArtifactEdits(input: unknown): Artifact {
  if (!input || typeof input !== 'object') throw new Error(text('code.invalidEdits'))
  const { projectId, baseArtifactId, files } = input as Record<string, unknown>
  if (typeof projectId !== 'string' || typeof baseArtifactId !== 'string' || !Array.isArray(files))
    throw new Error(text('code.invalidEdits'))
  const base = getArtifact(baseArtifactId)
  if (!base || base.projectId !== projectId) throw new Error(text('code.invalidVersion'))
  const original = new Map(getArtifactFiles(baseArtifactId).map((f) => [f.path, f.content]))
  const writes = new Map<string, string>()
  const seen = new Set<string>()
  for (const file of files) {
    if (
      !file ||
      typeof file.path !== 'string' ||
      typeof file.content !== 'string' ||
      !original.has(file.path) ||
      seen.has(file.path)
    )
      throw new Error(text('code.invalidEdits'))
    seen.add(file.path)
    if (original.get(file.path) !== file.content) writes.set(file.path, file.content)
  }
  if (!writes.size) return base
  return createArtifactVersion({
    projectId,
    baseArtifactId,
    messageId: null,
    writes,
    deletes: new Set(),
    summary: 'Manual code edits'
  })
}

export function deleteArtifact(input: unknown): Artifact[] {
  if (!input || typeof input !== 'object') throw new Error(text('code.invalidVersion'))
  const { projectId, artifactId } = input as Record<string, unknown>
  if (typeof projectId !== 'string' || !projectId || typeof artifactId !== 'string' || !artifactId)
    throw new Error(text('code.invalidVersion'))
  return getDb().transaction((tx) => {
    const versions = tx
      .select()
      .from(artifacts)
      .where(eq(artifacts.projectId, projectId))
      .orderBy(desc(artifacts.version))
      .all()
    if (!versions.some((version) => version.id === artifactId))
      throw new Error(text('code.invalidVersion'))
    if (versions.length <= 1) throw new Error(text('versions.keepLast'))
    const remaining = versions.filter((version) => version.id !== artifactId)
    const project = tx.select().from(projects).where(eq(projects.id, projectId)).get()!
    if (project.settings?.selectedArtifactId === artifactId) {
      tx.update(projects)
        .set({ settings: { ...project.settings, selectedArtifactId: remaining[0].id } })
        .where(eq(projects.id, projectId))
        .run()
    }
    // Snapshots are self-contained, so removing ancestry does not alter surviving files.
    tx.update(artifacts)
      .set({ baseArtifactId: null })
      .where(eq(artifacts.baseArtifactId, artifactId))
      .run()
    tx.update(messages).set({ artifactId: null }).where(eq(messages.artifactId, artifactId)).run()
    tx.delete(artifacts).where(eq(artifacts.id, artifactId)).run()
    return remaining.map((version) =>
      toView({
        ...version,
        baseArtifactId: version.baseArtifactId === artifactId ? null : version.baseArtifactId
      })
    )
  })
}
