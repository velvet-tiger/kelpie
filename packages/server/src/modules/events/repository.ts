import { and, asc, eq, gte, ilike, inArray, lte, or, sql } from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'

import type { IdFactory } from '../../lib/ids.ts'
import { keysetCondition, orderByWindow, textSort, timestampSort } from '../../lib/pagination.ts'
import type { ListWindow, SortableFields } from '../../lib/pagination.ts'
import { arrayContainsPattern, containsPattern } from '../../lib/search.ts'
import type { Queryable } from '../../runtime/transaction.ts'
import { workspaceMembers } from '../workspace/schema.ts'
import { attendances, eventAssociations, events } from './schema.ts'
import type { EventAssociationTargetType } from './schema.ts'

export type EventRecord = typeof events.$inferSelect
export type EventColumns = typeof events.$inferInsert
export type AttendanceRecord = typeof attendances.$inferSelect
export type AttendanceColumns = typeof attendances.$inferInsert
export type EventAssociationRecord = typeof eventAssociations.$inferSelect

export const EVENT_SORTS: SortableFields<EventRecord> = {
  name: textSort(events.name, (event) => event.name),
  starts_at: timestampSort(events.startsAt, (event) => event.startsAt),
  created_at: timestampSort(events.createdAt, (event) => event.createdAt),
  updated_at: timestampSort(events.updatedAt, (event) => event.updatedAt),
}

export const DEFAULT_EVENT_SORT = 'starts_at'

export interface EventFilters {
  readonly term?: string | undefined
  readonly statuses?: readonly string[] | undefined
  readonly formats?: readonly string[] | undefined
  readonly ownerIds?: readonly string[] | undefined
  readonly from?: Date | undefined
  readonly to?: Date | undefined
}

function matchesTerm(term: string): SQL | undefined {
  const pattern = containsPattern(term)

  return or(
    ilike(events.name, pattern),
    ilike(events.summary, pattern),
    ilike(events.kind, pattern),
    ilike(events.location, pattern),
    ilike(events.details, pattern),
    arrayContainsPattern(events.tags, pattern),
  )
}

function eventConditionsFor(workspaceId: string, filters: EventFilters): (SQL | undefined)[] {
  return [
    eq(events.workspaceId, workspaceId),
    filters.term === undefined ? undefined : matchesTerm(filters.term),
    filters.statuses === undefined ? undefined : inArray(events.status, filters.statuses),
    filters.formats === undefined ? undefined : inArray(events.format, filters.formats),
    filters.ownerIds === undefined ? undefined : inArray(events.ownerId, filters.ownerIds),
    filters.from === undefined ? undefined : gte(events.startsAt, filters.from),
    filters.to === undefined ? undefined : lte(events.startsAt, filters.to),
  ]
}

export function listEvents(
  db: Queryable,
  workspaceId: string,
  filters: EventFilters,
  window: ListWindow<EventRecord>,
): Promise<EventRecord[]> {
  return db
    .select()
    .from(events)
    .where(and(...eventConditionsFor(workspaceId, filters), keysetCondition(window, events.id)))
    .orderBy(...orderByWindow(window, events.id))
    .limit(window.fetchLimit)
}

export async function findEvent(
  db: Queryable,
  workspaceId: string,
  id: string,
): Promise<EventRecord | undefined> {
  const [found] = await db
    .select()
    .from(events)
    .where(and(eq(events.workspaceId, workspaceId), eq(events.id, id)))
    .limit(1)

  return found
}

export async function insertEvent(db: Queryable, values: EventColumns): Promise<EventRecord> {
  const [created] = await db.insert(events).values(values).returning()

  if (created === undefined) {
    throw new Error(`Inserting event ${values.id} returned no row`)
  }

  return created
}

export async function updateEvent(
  db: Queryable,
  workspaceId: string,
  id: string,
  changes: Partial<EventColumns>,
): Promise<EventRecord | undefined> {
  const [updated] = await db
    .update(events)
    .set(changes)
    .where(and(eq(events.workspaceId, workspaceId), eq(events.id, id)))
    .returning()

  return updated
}

export async function deleteEvent(db: Queryable, workspaceId: string, id: string): Promise<number> {
  const deleted = await db
    .delete(events)
    .where(and(eq(events.workspaceId, workspaceId), eq(events.id, id)))
    .returning({ id: events.id })

  return deleted.length
}

export async function memberExists(
  db: Queryable,
  workspaceId: string,
  memberId: string,
): Promise<boolean> {
  const [found] = await db
    .select({ id: workspaceMembers.id })
    .from(workspaceMembers)
    .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.id, memberId)))
    .limit(1)

  return found !== undefined
}

export interface AssociationRef {
  readonly targetType: EventAssociationTargetType
  readonly targetId: string
}

export async function listAssociations(
  db: Queryable,
  workspaceId: string,
  eventId: string,
): Promise<readonly AssociationRef[]> {
  const rows = await db
    .select({
      targetType: eventAssociations.targetType,
      targetId: eventAssociations.targetId,
    })
    .from(eventAssociations)
    .where(
      and(eq(eventAssociations.workspaceId, workspaceId), eq(eventAssociations.eventId, eventId)),
    )
    .orderBy(asc(eventAssociations.targetType), asc(eventAssociations.targetId))

  return rows.map((row) => ({
    targetType: row.targetType as EventAssociationTargetType,
    targetId: row.targetId,
  }))
}

export async function listAssociationsByTarget(
  db: Queryable,
  workspaceId: string,
  targetType: EventAssociationTargetType,
  targetId: string,
): Promise<readonly { readonly eventId: string; readonly eventName: string }[]> {
  return db
    .select({ eventId: events.id, eventName: events.name })
    .from(eventAssociations)
    .innerJoin(events, eq(events.id, eventAssociations.eventId))
    .where(
      and(
        eq(eventAssociations.workspaceId, workspaceId),
        eq(eventAssociations.targetType, targetType),
        eq(eventAssociations.targetId, targetId),
      ),
    )
    .orderBy(asc(events.startsAt), asc(events.id))
}

export async function replaceAssociations(
  db: Queryable,
  createId: IdFactory,
  workspaceId: string,
  eventId: string,
  next: readonly AssociationRef[],
): Promise<void> {
  await db
    .delete(eventAssociations)
    .where(
      and(eq(eventAssociations.workspaceId, workspaceId), eq(eventAssociations.eventId, eventId)),
    )

  if (next.length === 0) {
    return
  }

  await db.insert(eventAssociations).values(
    next.map((row) => ({
      id: createId('eventAssociation'),
      workspaceId,
      eventId,
      targetType: row.targetType,
      targetId: row.targetId,
    })),
  )
}

export async function deleteAssociationsForTarget(
  db: Queryable,
  workspaceId: string,
  targetType: string,
  targetId: string,
): Promise<number> {
  const deleted = await db
    .delete(eventAssociations)
    .where(
      and(
        eq(eventAssociations.workspaceId, workspaceId),
        eq(eventAssociations.targetType, targetType),
        eq(eventAssociations.targetId, targetId),
      ),
    )
    .returning({ id: eventAssociations.id })

  return deleted.length
}

export const ATTENDANCE_SORTS: SortableFields<AttendanceRecord> = {
  created_at: timestampSort(attendances.createdAt, (row) => row.createdAt),
  updated_at: timestampSort(attendances.updatedAt, (row) => row.updatedAt),
}

export const DEFAULT_ATTENDANCE_SORT = '-created_at'

export interface AttendanceFilters {
  readonly eventIds?: readonly string[] | undefined
  readonly personIds?: readonly string[] | undefined
  readonly statuses?: readonly string[] | undefined
}

function attendanceConditionsFor(
  workspaceId: string,
  filters: AttendanceFilters,
): (SQL | undefined)[] {
  return [
    eq(attendances.workspaceId, workspaceId),
    filters.eventIds === undefined ? undefined : inArray(attendances.eventId, filters.eventIds),
    filters.personIds === undefined ? undefined : inArray(attendances.personId, filters.personIds),
    filters.statuses === undefined ? undefined : inArray(attendances.status, filters.statuses),
  ]
}

export function listAttendances(
  db: Queryable,
  workspaceId: string,
  filters: AttendanceFilters,
  window: ListWindow<AttendanceRecord>,
): Promise<AttendanceRecord[]> {
  return db
    .select()
    .from(attendances)
    .where(
      and(
        ...attendanceConditionsFor(workspaceId, filters),
        keysetCondition(window, attendances.id),
      ),
    )
    .orderBy(...orderByWindow(window, attendances.id))
    .limit(window.fetchLimit)
}

export async function findAttendance(
  db: Queryable,
  workspaceId: string,
  id: string,
): Promise<AttendanceRecord | undefined> {
  const [found] = await db
    .select()
    .from(attendances)
    .where(and(eq(attendances.workspaceId, workspaceId), eq(attendances.id, id)))
    .limit(1)

  return found
}

export async function insertAttendance(
  db: Queryable,
  values: AttendanceColumns,
): Promise<AttendanceRecord> {
  const [created] = await db.insert(attendances).values(values).returning()

  if (created === undefined) {
    throw new Error(`Inserting attendance ${values.id} returned no row`)
  }

  return created
}

/**
 * Insert or return the existing row. Used by form submit so a retry is ok.
 *
 * Uses `ON CONFLICT DO NOTHING` rather than catching a unique violation: a
 * caught 23505 still aborts the surrounding savepoint, and the follow-up
 * select would then fail.
 *
 * @returns The row and whether it was newly inserted.
 */
export async function insertAttendanceIfAbsent(
  db: Queryable,
  values: AttendanceColumns,
): Promise<{ readonly record: AttendanceRecord; readonly inserted: boolean }> {
  const inserted = await db
    .insert(attendances)
    .values(values)
    .onConflictDoNothing({ target: [attendances.eventId, attendances.personId] })
    .returning()

  if (inserted[0] !== undefined) {
    return { record: inserted[0], inserted: true }
  }

  const [existing] = await db
    .select()
    .from(attendances)
    .where(
      and(eq(attendances.eventId, values.eventId), eq(attendances.personId, values.personId)),
    )
    .limit(1)

  if (existing === undefined) {
    throw new Error(`Attendance for ${values.eventId} and ${values.personId} was neither inserted nor found`)
  }

  return { record: existing, inserted: false }
}

export async function updateAttendance(
  db: Queryable,
  workspaceId: string,
  id: string,
  changes: Partial<AttendanceColumns>,
): Promise<AttendanceRecord | undefined> {
  const [updated] = await db
    .update(attendances)
    .set(changes)
    .where(and(eq(attendances.workspaceId, workspaceId), eq(attendances.id, id)))
    .returning()

  return updated
}

export async function deleteAttendance(
  db: Queryable,
  workspaceId: string,
  id: string,
): Promise<number> {
  const deleted = await db
    .delete(attendances)
    .where(and(eq(attendances.workspaceId, workspaceId), eq(attendances.id, id)))
    .returning({ id: attendances.id })

  return deleted.length
}

export async function listAttendanceIdsForEvent(
  db: Queryable,
  workspaceId: string,
  eventId: string,
): Promise<readonly string[]> {
  const rows = await db
    .select({ id: attendances.id })
    .from(attendances)
    .where(and(eq(attendances.workspaceId, workspaceId), eq(attendances.eventId, eventId)))

  return rows.map((row) => row.id)
}

export async function listAttendanceIdsForPerson(
  db: Queryable,
  workspaceId: string,
  personId: string,
): Promise<readonly string[]> {
  const rows = await db
    .select({ id: attendances.id })
    .from(attendances)
    .where(and(eq(attendances.workspaceId, workspaceId), eq(attendances.personId, personId)))

  return rows.map((row) => row.id)
}

export { sql }
