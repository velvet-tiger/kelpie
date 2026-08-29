import { and, asc, eq, inArray, sql } from 'drizzle-orm'
import type { AnyPgColumn } from 'drizzle-orm/pg-core'
import type { PipelineKind } from '@kelpie/schemas'

import type { IdFactory } from '../lib/ids.ts'
import type { Queryable } from '../runtime/transaction.ts'
import { people, personLinks } from './people/schema.ts'

/**
 * Shared reader/writer for `person_links`, the polymorphic table that holds a
 * person's involvement in a pipeline record. Every deal/opportunity/raise/
 * partnership service reaches through here rather than owning its own join
 * table. `personLinks` is defined in `people/schema.ts` because the person
 * side of the relation is what gives it the real foreign key.
 *
 * All functions take the caller's `Queryable` and `workspaceId` so every
 * query rides the `(workspace_id, target_type, target_id)` index and lands in
 * whatever transaction the caller opened.
 */

/**
 * One target the caller writes to. Kept named rather than positional so
 * `linkPeople(db, ids, ws, 'deal', dealId, personIds)` cannot swap the last
 * two arguments silently.
 */
export interface PipelineTarget {
  readonly targetType: PipelineKind
  readonly targetId: string
}

/**
 * The people on one pipeline record, ordered by person_id so a response is
 * stable across reads. Mirrors the deals repository's old `listPersonIds`.
 */
export async function listPersonIds(
  db: Queryable,
  workspaceId: string,
  target: PipelineTarget,
): Promise<string[]> {
  const rows = await db
    .select({ personId: personLinks.personId })
    .from(personLinks)
    .where(
      and(
        eq(personLinks.workspaceId, workspaceId),
        eq(personLinks.targetType, target.targetType),
        eq(personLinks.targetId, target.targetId),
      ),
    )
    .orderBy(asc(personLinks.personId))

  return rows.map((row) => row.personId)
}

/**
 * The people on each of a page of pipeline records of one type, in one query
 * rather than one per row. Ids missing from the map have no people.
 */
export async function listPersonIdsFor(
  db: Queryable,
  workspaceId: string,
  targetType: PipelineKind,
  targetIds: readonly string[],
): Promise<ReadonlyMap<string, readonly string[]>> {
  if (targetIds.length === 0) {
    return new Map()
  }

  const rows = await db
    .select({ targetId: personLinks.targetId, personId: personLinks.personId })
    .from(personLinks)
    .where(
      and(
        eq(personLinks.workspaceId, workspaceId),
        eq(personLinks.targetType, targetType),
        inArray(personLinks.targetId, targetIds),
      ),
    )
    .orderBy(asc(personLinks.personId))

  const byTarget = new Map<string, string[]>()

  for (const row of rows) {
    const existing = byTarget.get(row.targetId)

    if (existing === undefined) {
      byTarget.set(row.targetId, [row.personId])
    } else {
      existing.push(row.personId)
    }
  }

  return byTarget
}

/**
 * Every pipeline record a person is on, in one query. Used by the person
 * activity roll-up and the agent-tasks person case, which used to run one
 * query per join table.
 */
export async function listTargetsOfPerson(
  db: Queryable,
  workspaceId: string,
  personId: string,
): Promise<readonly PipelineTarget[]> {
  const rows = await db
    .select({ targetType: personLinks.targetType, targetId: personLinks.targetId })
    .from(personLinks)
    .where(and(eq(personLinks.workspaceId, workspaceId), eq(personLinks.personId, personId)))

  return rows.map((row) => ({
    targetType: row.targetType as PipelineKind,
    targetId: row.targetId,
  }))
}

/**
 * The distinct target types still pointing at a person. Used by the 409 on
 * person delete to name each pipeline the person is on, without loading every
 * row.
 */
export async function listLinkedTargetTypes(
  db: Queryable,
  workspaceId: string,
  personId: string,
): Promise<readonly PipelineKind[]> {
  const rows = await db
    .selectDistinct({ targetType: personLinks.targetType })
    .from(personLinks)
    .where(and(eq(personLinks.workspaceId, workspaceId), eq(personLinks.personId, personId)))

  return rows.map((row) => row.targetType as PipelineKind)
}

/** Bulk insert; callers pre-dedupe as today. No-op on empty. */
export async function linkPeople(
  db: Queryable,
  createId: IdFactory,
  workspaceId: string,
  target: PipelineTarget,
  personIds: readonly string[],
): Promise<void> {
  if (personIds.length === 0) {
    return
  }

  await db.insert(personLinks).values(
    personIds.map((personId) => ({
      id: createId('personLink'),
      workspaceId,
      personId,
      targetType: target.targetType,
      targetId: target.targetId,
    })),
  )
}

/** Bulk delete matching a set of people. No-op on empty. */
export async function unlinkPeople(
  db: Queryable,
  workspaceId: string,
  target: PipelineTarget,
  personIds: readonly string[],
): Promise<void> {
  if (personIds.length === 0) {
    return
  }

  await db
    .delete(personLinks)
    .where(
      and(
        eq(personLinks.workspaceId, workspaceId),
        eq(personLinks.targetType, target.targetType),
        eq(personLinks.targetId, target.targetId),
        inArray(personLinks.personId, personIds),
      ),
    )
}

/**
 * Link one person, skipping if the row already exists. Used by the forms
 * post-submit actions: a resubmitting visitor does not double-attach.
 *
 * @returns `true` when a row was inserted, `false` when the link already existed.
 */
export async function linkPersonIfAbsent(
  db: Queryable,
  createId: IdFactory,
  workspaceId: string,
  target: PipelineTarget,
  personId: string,
): Promise<boolean> {
  const inserted = await db
    .insert(personLinks)
    .values({
      id: createId('personLink'),
      workspaceId,
      personId,
      targetType: target.targetType,
      targetId: target.targetId,
    })
    .onConflictDoNothing({
      target: [personLinks.personId, personLinks.targetType, personLinks.targetId],
    })
    .returning({ id: personLinks.id })

  return inserted.length > 0
}

/**
 * Target-side cleanup, called from `attachedRecords.deleteRecordsAttachedTo`
 * when a pipeline record is deleted.
 *
 * @returns the number of rows removed.
 */
export async function deleteLinksForTarget(
  db: Queryable,
  workspaceId: string,
  target: PipelineTarget,
): Promise<number> {
  const deleted = await db
    .delete(personLinks)
    .where(
      and(
        eq(personLinks.workspaceId, workspaceId),
        eq(personLinks.targetType, target.targetType),
        eq(personLinks.targetId, target.targetId),
      ),
    )
    .returning({ id: personLinks.id })

  return deleted.length
}

/**
 * The `?person_id=` exists-subquery SQL builder, correlated on the outer
 * table's id and workspace columns. Replaces the identical `hasAnyOfPeople`
 * helpers that used to live in each pipeline module's repository.
 */
export function anyPersonLinked(
  targetType: PipelineKind,
  targetIdColumn: AnyPgColumn,
  workspaceIdColumn: AnyPgColumn,
  personIds: readonly string[],
): ReturnType<typeof sql> {
  return sql`exists (
    select 1
    from ${personLinks}
    where ${personLinks.workspaceId} = ${workspaceIdColumn}
      and ${personLinks.targetType} = ${targetType}
      and ${personLinks.targetId} = ${targetIdColumn}
      and ${inArray(personLinks.personId, personIds)}
  )`
}

/**
 * The names of these people in this workspace, keyed by id. Reads the
 * `people` table because that is where names live; used by every pipeline
 * service to validate `person_ids` and label the `linked`/`unlinked`
 * activity. An id missing from the map does not exist in this workspace.
 */
export async function findPeopleNamed(
  db: Queryable,
  workspaceId: string,
  personIds: readonly string[],
): Promise<ReadonlyMap<string, string>> {
  if (personIds.length === 0) {
    return new Map()
  }

  const rows = await db
    .select({ id: people.id, name: people.name })
    .from(people)
    .where(and(eq(people.workspaceId, workspaceId), inArray(people.id, personIds)))

  return new Map(rows.map((row) => [row.id, row.name]))
}
