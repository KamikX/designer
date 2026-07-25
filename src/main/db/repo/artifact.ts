import { asc, desc, eq, sql } from 'drizzle-orm'
import type { Artifact, ArtifactFile } from '../../../shared/types'
import { getDb } from '../index'
import { artifactFiles, artifacts } from '../schema'
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
  messageId: string
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
