import { and, eq } from 'drizzle-orm'

import type { Queryable } from '../../runtime/transaction.ts'
import { decisions } from './schema.ts'

export type DecisionRecord = typeof decisions.$inferSelect

/**
 * Removes every decision attached to a target.
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
    .delete(decisions)
    .where(
      and(
        eq(decisions.workspaceId, workspaceId),
        eq(decisions.targetType, targetType),
        eq(decisions.targetId, targetId),
      ),
    )
    .returning({ id: decisions.id })

  return deleted.length
}
