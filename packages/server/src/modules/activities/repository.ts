import { and, eq } from 'drizzle-orm'

import type { Queryable } from '../../runtime/transaction.ts'
import { activities } from './schema.ts'

export type ActivityRecord = typeof activities.$inferSelect

/**
 * Removes every activity attached to a target.
 *
 * The target is polymorphic and carries no foreign key, so nothing in the
 * database deletes these. The service that deletes the target calls this inside
 * the same transaction (`schema.md`).
 */
export async function deleteForTarget(
  db: Queryable,
  workspaceId: string,
  targetType: string,
  targetId: string,
): Promise<number> {
  const deleted = await db
    .delete(activities)
    .where(
      and(
        eq(activities.workspaceId, workspaceId),
        eq(activities.targetType, targetType),
        eq(activities.targetId, targetId),
      ),
    )
    .returning({ id: activities.id })

  return deleted.length
}
