import { eq, sql } from 'drizzle-orm'
import type { GroupDigestSnapshot } from '../../ai/group-transcript'
import { getDb } from '../index'
import { groupDigests } from '../schema'

/** 群组前情纪要仓储。一个会话恒一行,upsert 即全部写语义。 */

export function getGroupDigest(conversationId: string): GroupDigestSnapshot | null {
  const row = getDb()
    .select()
    .from(groupDigests)
    .where(eq(groupDigests.conversationId, conversationId))
    .get()
  return row ? { text: row.text, coveredUntilId: row.coveredUntilId } : null
}

export function saveGroupDigest(conversationId: string, digest: GroupDigestSnapshot): void {
  getDb()
    .insert(groupDigests)
    .values({
      conversationId,
      text: digest.text,
      coveredUntilId: digest.coveredUntilId
    })
    .onConflictDoUpdate({
      target: groupDigests.conversationId,
      set: {
        text: digest.text,
        coveredUntilId: digest.coveredUntilId,
        updatedAt: sql`(datetime('now'))`
      }
    })
    .run()
}
