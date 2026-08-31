import { and, asc, eq, ilike, inArray, or } from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'
import type { AnyPgColumn } from 'drizzle-orm/pg-core'
import type { FormSubmissionLinkTarget, PipelineKind } from '@kelpie/schemas'

import { keysetCondition, orderByWindow, textSort, timestampSort } from '../../lib/pagination.ts'
import type { ListWindow, SortableFields } from '../../lib/pagination.ts'
import { containsPattern } from '../../lib/search.ts'
import type { Queryable } from '../../runtime/transaction.ts'
import { lists } from '../lists/schema.ts'
import type { RecordTargetType } from '../recordTargets.ts'
import { formAttachTargets, formFields, formLists, formSubmissions, forms } from './schema.ts'

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

/**
 * Maps each `FormSubmissionLinkTarget` (declared in `@kelpie/schemas`) to the
 * drizzle column that names the record. Keeping the enum in schemas keeps the
 * wire shape one source of truth; the column mapping lives here because it
 * references types the schemas package cannot see.
 */
const SUBMISSION_LINK_COLUMNS: Readonly<Record<FormSubmissionLinkTarget, AnyPgColumn>> = {
  person: formSubmissions.personId,
  company: formSubmissions.companyId,
  position: formSubmissions.positionId,
  deal: formSubmissions.dealId,
  opportunity: formSubmissions.opportunityId,
  partnership: formSubmissions.partnershipId,
  enquiry: formSubmissions.enquiryId,
}

/**
 * Lists submissions whose {target}_id points at `targetId`.
 *
 * The record itself is not checked here — the workspace scope and the FK
 * filter are enough for a read. A caller reaching for a target from another
 * workspace or one that no longer exists gets an empty page, which mirrors
 * the answer any other cross-workspace read gives.
 */
export function listSubmissionsLinkedTo(
  db: Queryable,
  workspaceId: string,
  target: FormSubmissionLinkTarget,
  targetId: string,
  window: ListWindow<FormSubmissionRecord>,
): Promise<FormSubmissionRecord[]> {
  return db
    .select()
    .from(formSubmissions)
    .where(
      and(
        eq(formSubmissions.workspaceId, workspaceId),
        eq(SUBMISSION_LINK_COLUMNS[target], targetId),
        keysetCondition(window, formSubmissions.id),
      ),
    )
    .orderBy(...orderByWindow(window, formSubmissions.id))
    .limit(window.fetchLimit)
}

export async function findSubmission(
  db: Queryable,
  workspaceId: string,
  formId: string,
  id: string,
): Promise<FormSubmissionRecord | undefined> {
  const [row] = await db
    .select()
    .from(formSubmissions)
    .where(
      and(
        eq(formSubmissions.workspaceId, workspaceId),
        eq(formSubmissions.formId, formId),
        eq(formSubmissions.id, id),
      ),
    )
    .limit(1)

  return row
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

/** One form's configured list memberships, joined to the list for target-type. */
export interface FormListRow {
  readonly listId: string
  readonly targetType: RecordTargetType
  /**
   * When the list has a consent purpose, form-driven adds capture consent
   * against it. Carried through so submission.ts needs no second query.
   */
  readonly consentPurposeId: string | null
}

export async function listFormLists(db: Queryable, formId: string): Promise<FormListRow[]> {
  const rows = await db
    .select({
      listId: formLists.listId,
      targetType: lists.targetType,
      consentPurposeId: lists.consentPurposeId,
    })
    .from(formLists)
    .innerJoin(lists, eq(lists.id, formLists.listId))
    .where(eq(formLists.formId, formId))
    .orderBy(asc(formLists.listId))

  return rows.map((row) => ({
    listId: row.listId,
    targetType: row.targetType as RecordTargetType,
    consentPurposeId: row.consentPurposeId,
  }))
}

export async function replaceFormLists(
  db: Queryable,
  workspaceId: string,
  formId: string,
  listIds: readonly string[],
): Promise<void> {
  await db.delete(formLists).where(eq(formLists.formId, formId))

  if (listIds.length === 0) {
    return
  }

  await db.insert(formLists).values(listIds.map((listId) => ({ workspaceId, formId, listId })))
}

/** One form's configured attach targets, ordered so a resent identical set is not a write. */
export interface FormAttachTargetRow {
  readonly targetType: PipelineKind
  readonly targetId: string
}

export async function listAttachTargets(
  db: Queryable,
  formId: string,
): Promise<FormAttachTargetRow[]> {
  const rows = await db
    .select({ targetType: formAttachTargets.targetType, targetId: formAttachTargets.targetId })
    .from(formAttachTargets)
    .where(eq(formAttachTargets.formId, formId))
    .orderBy(asc(formAttachTargets.targetType), asc(formAttachTargets.targetId))

  return rows.map((row) => ({
    targetType: row.targetType as PipelineKind,
    targetId: row.targetId,
  }))
}

export async function replaceAttachTargets(
  db: Queryable,
  workspaceId: string,
  formId: string,
  targets: readonly FormAttachTargetRow[],
): Promise<void> {
  await db.delete(formAttachTargets).where(eq(formAttachTargets.formId, formId))

  if (targets.length === 0) {
    return
  }

  await db
    .insert(formAttachTargets)
    .values(
      targets.map((target) => ({
        workspaceId,
        formId,
        targetType: target.targetType,
        targetId: target.targetId,
      })),
    )
}
