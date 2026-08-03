import { and, eq } from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'

import { keysetCondition, orderByWindow, timestampSort } from '../../lib/pagination.ts'
import type { ListWindow, SortableFields } from '../../lib/pagination.ts'
import type { Queryable } from '../../runtime/transaction.ts'
import type { RecordTargetType } from '../recordTargets.ts'
import { notes } from './schema.ts'

export type NoteRecord = typeof notes.$inferSelect

/** The writable column shape. Services build one of these; nothing else knows the column names. */
export type NoteColumns = typeof notes.$inferInsert

export const NOTE_SORTS: SortableFields<NoteRecord> = {
  created_at: timestampSort(notes.createdAt, (note) => note.createdAt),
  updated_at: timestampSort(notes.updatedAt, (note) => note.updatedAt),
}

export const DEFAULT_NOTE_SORT = '-created_at'

export interface NoteFilters {
  readonly targetType: RecordTargetType
  readonly targetId: string
  /** `?pinned=`. Absent returns both. Pinned notes are what agents read first. */
  readonly pinned?: boolean | undefined
}

function conditionsFor(workspaceId: string, filters: NoteFilters): (SQL | undefined)[] {
  return [
    eq(notes.workspaceId, workspaceId),
    eq(notes.targetType, filters.targetType),
    eq(notes.targetId, filters.targetId),
    filters.pinned === undefined ? undefined : eq(notes.pinned, filters.pinned),
  ]
}

/** @returns Up to `window.fetchLimit` rows: one more than the page, so the caller can tell there is a next one. */
export function listNotes(
  db: Queryable,
  workspaceId: string,
  filters: NoteFilters,
  window: ListWindow<NoteRecord>,
): Promise<NoteRecord[]> {
  return db
    .select()
    .from(notes)
    .where(and(...conditionsFor(workspaceId, filters), keysetCondition(window, notes.id)))
    .orderBy(...orderByWindow(window, notes.id))
    .limit(window.fetchLimit)
}

export async function findNote(
  db: Queryable,
  workspaceId: string,
  id: string,
): Promise<NoteRecord | undefined> {
  const [found] = await db
    .select()
    .from(notes)
    .where(and(eq(notes.workspaceId, workspaceId), eq(notes.id, id)))
    .limit(1)

  return found
}

export async function insertNote(db: Queryable, values: NoteColumns): Promise<NoteRecord> {
  const [created] = await db.insert(notes).values(values).returning()

  if (created === undefined) {
    throw new Error(`Inserting note ${values.id} returned no row`)
  }

  return created
}

export async function updateNote(
  db: Queryable,
  workspaceId: string,
  id: string,
  changes: Partial<NoteColumns>,
): Promise<NoteRecord | undefined> {
  const [updated] = await db
    .update(notes)
    .set(changes)
    .where(and(eq(notes.workspaceId, workspaceId), eq(notes.id, id)))
    .returning()

  return updated
}

export async function deleteNote(db: Queryable, workspaceId: string, id: string): Promise<number> {
  const deleted = await db
    .delete(notes)
    .where(and(eq(notes.workspaceId, workspaceId), eq(notes.id, id)))
    .returning({ id: notes.id })

  return deleted.length
}

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
