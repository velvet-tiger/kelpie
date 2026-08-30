import { and, eq } from 'drizzle-orm'

import type { Queryable } from '../runtime/transaction.ts'
import { deals } from './deals/schema.ts'
import { enquiries } from './enquiries/schema.ts'
import { opportunities } from './opportunities/schema.ts'
import { partnerships } from './partnerships/schema.ts'
import type { PipelineKind } from './pipelines/schema.ts'
import { raises } from './raises/schema.ts'

/**
 * The five tables whose rows sit in a pipeline stage, for the one operation that
 * spans them all: removing a stage moves whatever still references it.
 *
 * Touching five modules' tables here rather than composing five services follows
 * `attachedRecords.ts`: the alternative is a stage removal that imports every
 * staged service to ask each for a bulk move it exists for nowhere else.
 *
 * Five written-out branches rather than a table-of-tables, because Drizzle's
 * `update().set()` needs the concrete table type to check the column names.
 */

export interface StagedRecordMove {
  readonly workspaceId: string
  readonly fromStageId: string
  readonly toStageId: string
  readonly movedAt: Date
}

/**
 * Moves every record of one kind out of a stage.
 *
 * @param db Must be the caller's transaction: the move only makes sense alongside
 *   the stage delete that forced it.
 * @returns The ids that moved, for the caller's activity trail and events.
 */
export async function reassignStagedRecords(
  db: Queryable,
  kind: PipelineKind,
  move: StagedRecordMove,
): Promise<readonly string[]> {
  const changes = { stageId: move.toStageId, updatedAt: move.movedAt }

  switch (kind) {
    case 'deal': {
      const moved = await db
        .update(deals)
        .set(changes)
        .where(and(eq(deals.workspaceId, move.workspaceId), eq(deals.stageId, move.fromStageId)))
        .returning({ id: deals.id })

      return moved.map((row) => row.id)
    }
    case 'opportunity': {
      const moved = await db
        .update(opportunities)
        .set(changes)
        .where(
          and(
            eq(opportunities.workspaceId, move.workspaceId),
            eq(opportunities.stageId, move.fromStageId),
          ),
        )
        .returning({ id: opportunities.id })

      return moved.map((row) => row.id)
    }
    case 'raise': {
      const moved = await db
        .update(raises)
        .set(changes)
        .where(and(eq(raises.workspaceId, move.workspaceId), eq(raises.stageId, move.fromStageId)))
        .returning({ id: raises.id })

      return moved.map((row) => row.id)
    }
    case 'partnership': {
      const moved = await db
        .update(partnerships)
        .set(changes)
        .where(
          and(
            eq(partnerships.workspaceId, move.workspaceId),
            eq(partnerships.stageId, move.fromStageId),
          ),
        )
        .returning({ id: partnerships.id })

      return moved.map((row) => row.id)
    }
    case 'enquiry': {
      const moved = await db
        .update(enquiries)
        .set(changes)
        .where(
          and(
            eq(enquiries.workspaceId, move.workspaceId),
            eq(enquiries.stageId, move.fromStageId),
          ),
        )
        .returning({ id: enquiries.id })

      return moved.map((row) => row.id)
    }
  }
}
