import { and, asc, eq, ilike, inArray, or } from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'

import { keysetCondition, orderByWindow, textSort, timestampSort } from '../../lib/pagination.ts'
import type { ListWindow, SortableFields } from '../../lib/pagination.ts'
import { containsPattern } from '../../lib/search.ts'
import type { Queryable } from '../../runtime/transaction.ts'
import { formFields, formSubmissions, forms } from './schema.ts'

export type FormRecord = typeof forms.$inferSelect
export type FormFieldRecord = typeof formFields.$inferSelect
export type FormSubmissionRecord = typeof formSubmissions.$inferSelect

/** The writable column shapes. Services build these; nothing else knows the column names. */
export type FormColumns = typeof forms.$inferInsert
export type FormFieldColumns = typeof formFields.$inferInsert
export type FormSubmissionColumns = typeof formSubmissions.$inferInsert

export const FORM_SORTS: SortableFields<FormRecord> = {
  name: textSort(forms.name, (form) => form.name),
  created_at: timestampSort(forms.createdAt, (form) => form.createdAt),
  updated_at: timestampSort(forms.updatedAt, (form) => form.updatedAt),
}

export const DEFAULT_FORM_SORT = '-created_at'

/**
 * Submissions sort newest-first and by nothing else.
 *
 * `submitted_at` rather than `created_at`, even though a submit writes both at
 * once: the two come apart the moment an import backfills historical
 * submissions, and the question a reader asks is when the form was filled in.
 */
export const FORM_SUBMISSION_SORTS: SortableFields<FormSubmissionRecord> = {
  submitted_at: timestampSort(formSubmissions.submittedAt, (row) => row.submittedAt),
  created_at: timestampSort(formSubmissions.createdAt, (row) => row.createdAt),
}

export const DEFAULT_FORM_SUBMISSION_SORT = '-submitted_at'

export interface FormFilters {
  /** `?q=`: name and description. */
  readonly term?: string | undefined
  /** `?status=`: `active` or `paused`. */
  readonly status?: string | undefined
}

function conditionsFor(workspaceId: string, filters: FormFilters): (SQL | undefined)[] {
  const pattern = filters.term === undefined ? undefined : containsPattern(filters.term)

  return [
    eq(forms.workspaceId, workspaceId),
    pattern === undefined ? undefined : or(ilike(forms.name, pattern), ilike(forms.description, pattern)),
    filters.status === undefined ? undefined : eq(forms.status, filters.status),
  ]
}

/** @returns Up to `window.fetchLimit` rows: one more than the page, so the caller can tell there is a next one. */
export function listForms(
  db: Queryable,
  workspaceId: string,
  filters: FormFilters,
  window: ListWindow<FormRecord>,
): Promise<FormRecord[]> {
  return db
    .select()
    .from(forms)
    .where(and(...conditionsFor(workspaceId, filters), keysetCondition(window, forms.id)))
    .orderBy(...orderByWindow(window, forms.id))
    .limit(window.fetchLimit)
}

export async function findForm(
  db: Queryable,
  workspaceId: string,
  id: string,
): Promise<FormRecord | undefined> {
  const [found] = await db
    .select()
    .from(forms)
    .where(and(eq(forms.workspaceId, workspaceId), eq(forms.id, id)))
    .limit(1)

  return found
}

/**
 * The one lookup in this service that is not workspace-scoped, because it is
 * what resolves the workspace.
 *
 * `public_key` is unique across every workspace (`schema.ts`), so this answers
 * with at most one row and the caller reads `workspaceId` off it. Nothing else
 * on a public request may name a workspace.
 */
export async function findFormByPublicKey(
  db: Queryable,
  publicKey: string,
): Promise<FormRecord | undefined> {
  const [found] = await db.select().from(forms).where(eq(forms.publicKey, publicKey)).limit(1)

  return found
}

export async function insertForm(db: Queryable, values: FormColumns): Promise<FormRecord> {
  const [created] = await db.insert(forms).values(values).returning()

  if (created === undefined) {
    throw new Error(`Inserting form ${values.id} returned no row`)
  }

  return created
}

export async function updateForm(
  db: Queryable,
  workspaceId: string,
  id: string,
  changes: Partial<FormColumns>,
): Promise<FormRecord | undefined> {
  const [updated] = await db
    .update(forms)
    .set(changes)
    .where(and(eq(forms.workspaceId, workspaceId), eq(forms.id, id)))
    .returning()

  return updated
}

/** Fields and submissions die with the form through their foreign keys. */
export async function deleteForm(db: Queryable, workspaceId: string, id: string): Promise<number> {
  const deleted = await db
    .delete(forms)
    .where(and(eq(forms.workspaceId, workspaceId), eq(forms.id, id)))
    .returning({ id: forms.id })

  return deleted.length
}

/** One form's fields, in the order the embed renders them. */
export function listFields(db: Queryable, formId: string): Promise<FormFieldRecord[]> {
  return db
    .select()
    .from(formFields)
    .where(eq(formFields.formId, formId))
    .orderBy(asc(formFields.sortOrder), asc(formFields.id))
}

/**
 * The fields of a page of forms, in one query.
 *
 * A list of forms renders each one's field count and mapping summary, and
 * `api.md` has no `include` expansion, so the alternative is one query per row.
 */
export function listFieldsFor(
  db: Queryable,
  formIds: readonly string[],
): Promise<FormFieldRecord[]> {
  if (formIds.length === 0) {
    return Promise.resolve([])
  }

  return db
    .select()
    .from(formFields)
    .where(inArray(formFields.formId, formIds))
    .orderBy(asc(formFields.sortOrder), asc(formFields.id))
}

export async function insertFields(
  db: Queryable,
  values: readonly FormFieldColumns[],
): Promise<FormFieldRecord[]> {
  if (values.length === 0) {
    return []
  }

  return db.insert(formFields).values([...values]).returning()
}

/**
 * Drops every field of a form, so the caller can write the list it was given.
 *
 * A write replaces the whole list rather than diffing it. Field ids are not
 * addressable on the wire, positions are derived from the array's order, and a
 * drag-reorder changes every position after the one that moved: a diff would be
 * more code for the same rows.
 */
export async function deleteFields(db: Queryable, formId: string): Promise<void> {
  await db.delete(formFields).where(eq(formFields.formId, formId))
}

export function listSubmissions(
  db: Queryable,
  workspaceId: string,
  formId: string,
  window: ListWindow<FormSubmissionRecord>,
): Promise<FormSubmissionRecord[]> {
  return db
    .select()
    .from(formSubmissions)
    .where(
      and(
        eq(formSubmissions.workspaceId, workspaceId),
        eq(formSubmissions.formId, formId),
        keysetCondition(window, formSubmissions.id),
      ),
    )
    .orderBy(...orderByWindow(window, formSubmissions.id))
    .limit(window.fetchLimit)
}

export async function insertSubmission(
  db: Queryable,
  values: FormSubmissionColumns,
): Promise<FormSubmissionRecord> {
  const [created] = await db.insert(formSubmissions).values(values).returning()

  if (created === undefined) {
    throw new Error(`Inserting form submission ${values.id} returned no row`)
  }

  return created
}
