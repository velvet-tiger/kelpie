import { and, eq } from 'drizzle-orm'
import type { PipelineKind } from '@kelpie/schemas'

import type { Queryable } from '../../runtime/transaction.ts'
import { deals } from '../deals/schema.ts'
import { enquiries } from '../enquiries/schema.ts'
import { opportunities } from '../opportunities/schema.ts'
import { partnerships } from '../partnerships/schema.ts'
import { raises } from '../raises/schema.ts'

/**
 * Clears `converted_target_*` on every pipeline record that pointed at a target
 * being deleted. Enquiries also lose `converted_deal_id` when the target is a
 * deal, matching the legacy FK `on delete set null` behaviour and allowing a
 * fresh conversion once the created record is gone.
 */
export async function clearConversionPointersToTarget(
  tx: Queryable,
  workspaceId: string,
  targetKind: PipelineKind,
  targetId: string,
): Promise<void> {
  const match = and(
    eq(deals.workspaceId, workspaceId),
    eq(deals.convertedTargetType, targetKind),
    eq(deals.convertedTargetId, targetId),
  )

  await tx
    .update(enquiries)
    .set({
      convertedTargetType: null,
      convertedTargetId: null,
      ...(targetKind === 'deal' ? { convertedDealId: null } : {}),
    })
    .where(
      and(
        eq(enquiries.workspaceId, workspaceId),
        eq(enquiries.convertedTargetType, targetKind),
        eq(enquiries.convertedTargetId, targetId),
      ),
    )

  await tx
    .update(deals)
    .set({ convertedTargetType: null, convertedTargetId: null })
    .where(match)

  await tx
    .update(opportunities)
    .set({ convertedTargetType: null, convertedTargetId: null })
    .where(
      and(
        eq(opportunities.workspaceId, workspaceId),
        eq(opportunities.convertedTargetType, targetKind),
        eq(opportunities.convertedTargetId, targetId),
      ),
    )

  await tx
    .update(raises)
    .set({ convertedTargetType: null, convertedTargetId: null })
    .where(
      and(
        eq(raises.workspaceId, workspaceId),
        eq(raises.convertedTargetType, targetKind),
        eq(raises.convertedTargetId, targetId),
      ),
    )

  await tx
    .update(partnerships)
    .set({ convertedTargetType: null, convertedTargetId: null })
    .where(
      and(
        eq(partnerships.workspaceId, workspaceId),
        eq(partnerships.convertedTargetType, targetKind),
        eq(partnerships.convertedTargetId, targetId),
      ),
    )
}
