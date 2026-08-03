import { and, eq } from 'drizzle-orm'

import type { Queryable } from '../../runtime/transaction.ts'
import type { RecordTargetType } from '../recordTargets.ts'
import { planItems } from './schema.ts'

/**
 * Plan items have routes of their own only in a later feature; this exists now
 * because deleting a pipeline record must take its plan items with it
 * (`attachedRecords.ts`), and that path cannot wait for the Plans feature.
 */

export async function deleteForTarget(
  db: Queryable,
  workspaceId: string,
  targetType: RecordTargetType,
  targetId: string,
): Promise<number> {
  const deleted = await db
    .delete(planItems)
    .where(
      and(
        eq(planItems.workspaceId, workspaceId),
        eq(planItems.targetType, targetType),
        eq(planItems.targetId, targetId),
      ),
    )
    .returning({ id: planItems.id })

  return deleted.length
}
