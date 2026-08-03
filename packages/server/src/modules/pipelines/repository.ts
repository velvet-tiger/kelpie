import { and, asc, eq } from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'

import { integerSort, keysetCondition, orderByWindow, timestampSort } from '../../lib/pagination.ts'
import type { ListWindow, SortableFields } from '../../lib/pagination.ts'
import type { Queryable } from '../../runtime/transaction.ts'
import { pipelineStages } from './schema.ts'
import type { PipelineKind } from './schema.ts'

export type PipelineStageRecord = typeof pipelineStages.$inferSelect

/** The writable column shape. Services build one of these; nothing else knows the column names. */
export type PipelineStageColumns = typeof pipelineStages.$inferInsert

export const PIPELINE_STAGE_SORTS: SortableFields<PipelineStageRecord> = {
  sort_order: integerSort(pipelineStages.sortOrder, (stage) => stage.sortOrder),
  created_at: timestampSort(pipelineStages.createdAt, (stage) => stage.createdAt),
  updated_at: timestampSort(pipelineStages.updatedAt, (stage) => stage.updatedAt),
}

/** Board order, not creation order: a stage list is a board's columns. */
export const DEFAULT_PIPELINE_STAGE_SORT = 'sort_order'

export interface PipelineStageFilters {
  /** `?kind=`: one pipeline's stages. Absent lists all four pipelines' stages. */
  readonly kind?: PipelineKind | undefined
}

function conditionsFor(workspaceId: string, filters: PipelineStageFilters): (SQL | undefined)[] {
  return [
    eq(pipelineStages.workspaceId, workspaceId),
    filters.kind === undefined ? undefined : eq(pipelineStages.kind, filters.kind),
  ]
}

/** @returns Up to `window.fetchLimit` rows: one more than the page, so the caller can tell there is a next one. */
export function listStages(
  db: Queryable,
  workspaceId: string,
  filters: PipelineStageFilters,
  window: ListWindow<PipelineStageRecord>,
): Promise<PipelineStageRecord[]> {
  return db
    .select()
    .from(pipelineStages)
    .where(and(...conditionsFor(workspaceId, filters), keysetCondition(window, pipelineStages.id)))
    .orderBy(...orderByWindow(window, pipelineStages.id))
    .limit(window.fetchLimit)
}

/**
 * One pipeline's stages in board order, whole. Reordering, adding, and removing
 * all work on the full column list, which is small by construction.
 */
export function listStagesOfKind(
  db: Queryable,
  workspaceId: string,
  kind: PipelineKind,
): Promise<PipelineStageRecord[]> {
  return db
    .select()
    .from(pipelineStages)
    .where(and(eq(pipelineStages.workspaceId, workspaceId), eq(pipelineStages.kind, kind)))
    .orderBy(asc(pipelineStages.sortOrder), asc(pipelineStages.id))
}

export async function findStage(
  db: Queryable,
  workspaceId: string,
  id: string,
): Promise<PipelineStageRecord | undefined> {
  const [found] = await db
    .select()
    .from(pipelineStages)
    .where(and(eq(pipelineStages.workspaceId, workspaceId), eq(pipelineStages.id, id)))
    .limit(1)

  return found
}

export async function insertStage(
  db: Queryable,
  values: PipelineStageColumns,
): Promise<PipelineStageRecord> {
  const [created] = await db.insert(pipelineStages).values(values).returning()

  if (created === undefined) {
    throw new Error(`Inserting pipeline stage ${values.id} returned no row`)
  }

  return created
}

export async function updateStage(
  db: Queryable,
  workspaceId: string,
  id: string,
  changes: Partial<PipelineStageColumns>,
): Promise<PipelineStageRecord | undefined> {
  const [updated] = await db
    .update(pipelineStages)
    .set(changes)
    .where(and(eq(pipelineStages.workspaceId, workspaceId), eq(pipelineStages.id, id)))
    .returning()

  return updated
}

export async function deleteStage(db: Queryable, workspaceId: string, id: string): Promise<number> {
  const deleted = await db
    .delete(pipelineStages)
    .where(and(eq(pipelineStages.workspaceId, workspaceId), eq(pipelineStages.id, id)))
    .returning({ id: pipelineStages.id })

  return deleted.length
}
