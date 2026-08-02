import { and, eq } from 'drizzle-orm'

import type { Queryable } from '../../runtime/transaction.ts'
import { notes } from './schema.ts'

export type NoteRecord = typeof notes.$inferSelect

/**
 * Removes every note attached to a target.
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
    .delete(notes)
    .where(
      and(
        eq(notes.workspaceId, workspaceId),
        eq(notes.targetType, targetType),
        eq(notes.targetId, targetId),
      ),
    )
    .returning({ id: notes.id })

  return deleted.length
}
