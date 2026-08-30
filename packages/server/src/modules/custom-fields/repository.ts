import { and, asc, eq, ilike, inArray, sql } from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'

import { keysetCondition, orderByWindow, textSort, timestampSort } from '../../lib/pagination.ts'
import type { ListWindow, SortableFields } from '../../lib/pagination.ts'
import { containsPattern } from '../../lib/search.ts'
import type { Queryable } from '../../runtime/transaction.ts'
import { companies } from '../companies/schema.ts'
import { deals } from '../deals/schema.ts'
import { enquiries } from '../enquiries/schema.ts'
import { opportunities } from '../opportunities/schema.ts'
import { partnerships } from '../partnerships/schema.ts'
import { people } from '../people/schema.ts'
import { raises } from '../raises/schema.ts'
import type { CustomFieldObjectType } from './schema.ts'
import { customFieldDefinitions } from './schema.ts'

export type CustomFieldDefinitionRecord = typeof customFieldDefinitions.$inferSelect
export type CustomFieldDefinitionColumns = typeof customFieldDefinitions.$inferInsert

export const CUSTOM_FIELD_DEFINITION_SORTS: SortableFields<CustomFieldDefinitionRecord> = {
  sort_order: {
    column: customFieldDefinitions.sortOrder,
    valueOf: (row) => String(row.sortOrder),
    parse: (value) => {
      const parsed = Number(value)
      if (!Number.isInteger(parsed)) {
        throw new Error('sort_order cursor is not a whole number')
      }
      return parsed
    },
  },
  label: textSort(customFieldDefinitions.label, (row) => row.label),
  key: textSort(customFieldDefinitions.key, (row) => row.key),
  created_at: timestampSort(customFieldDefinitions.createdAt, (row) => row.createdAt),
  updated_at: timestampSort(customFieldDefinitions.updatedAt, (row) => row.updatedAt),
}

export const DEFAULT_CUSTOM_FIELD_DEFINITION_SORT = 'sort_order'

export interface CustomFieldDefinitionFilters {
  readonly term?: string | undefined
  readonly objectType?: CustomFieldObjectType | undefined
}

function conditionsFor(
  workspaceId: string,
  filters: CustomFieldDefinitionFilters,
): (SQL | undefined)[] {
  return [
    eq(customFieldDefinitions.workspaceId, workspaceId),
    filters.term === undefined
      ? undefined
      : ilike(customFieldDefinitions.label, containsPattern(filters.term)),
    filters.objectType === undefined
      ? undefined
      : eq(customFieldDefinitions.objectType, filters.objectType),
  ]
}

export function listDefinitions(
  db: Queryable,
  workspaceId: string,
  filters: CustomFieldDefinitionFilters,
  window: ListWindow<CustomFieldDefinitionRecord>,
): Promise<CustomFieldDefinitionRecord[]> {
  return db
    .select()
    .from(customFieldDefinitions)
    .where(
      and(...conditionsFor(workspaceId, filters), keysetCondition(window, customFieldDefinitions.id)),
    )
    .orderBy(...orderByWindow(window, customFieldDefinitions.id))
    .limit(window.fetchLimit)
}

export async function findDefinition(
  db: Queryable,
  workspaceId: string,
  id: string,
): Promise<CustomFieldDefinitionRecord | undefined> {
  const [found] = await db
    .select()
    .from(customFieldDefinitions)
    .where(and(eq(customFieldDefinitions.workspaceId, workspaceId), eq(customFieldDefinitions.id, id)))
    .limit(1)

  return found
}

/**
 * Every definition for one workspace, ordered as the editor renders them.
 *
 * Not paged: a workspace's whole set is small (hard cap 100 per object type),
 * and every write path — validation, delete-strip — needs the definitions for
 * one object type at once.
 */
export function definitionsForObject(
  db: Queryable,
  workspaceId: string,
  objectType: CustomFieldObjectType,
): Promise<CustomFieldDefinitionRecord[]> {
  return db
    .select()
    .from(customFieldDefinitions)
    .where(
      and(
        eq(customFieldDefinitions.workspaceId, workspaceId),
        eq(customFieldDefinitions.objectType, objectType),
      ),
    )
    .orderBy(asc(customFieldDefinitions.sortOrder), asc(customFieldDefinitions.id))
}

export async function countDefinitions(
  db: Queryable,
  workspaceId: string,
): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(customFieldDefinitions)
    .where(eq(customFieldDefinitions.workspaceId, workspaceId))

  return Number(row?.count ?? 0)
}

export async function insertDefinition(
  db: Queryable,
  values: CustomFieldDefinitionColumns,
): Promise<CustomFieldDefinitionRecord> {
  const [created] = await db.insert(customFieldDefinitions).values(values).returning()

  if (created === undefined) {
    throw new Error(`Inserting custom_field_definition ${values.id} returned no row`)
  }

  return created
}

export async function updateDefinition(
  db: Queryable,
  workspaceId: string,
  id: string,
  changes: Partial<CustomFieldDefinitionColumns>,
): Promise<CustomFieldDefinitionRecord | undefined> {
  const [updated] = await db
    .update(customFieldDefinitions)
    .set(changes)
    .where(and(eq(customFieldDefinitions.workspaceId, workspaceId), eq(customFieldDefinitions.id, id)))
    .returning()

  return updated
}

export async function deleteDefinition(
  db: Queryable,
  workspaceId: string,
  id: string,
): Promise<number> {
  const deleted = await db
    .delete(customFieldDefinitions)
    .where(and(eq(customFieldDefinitions.workspaceId, workspaceId), eq(customFieldDefinitions.id, id)))
    .returning({ id: customFieldDefinitions.id })

  return deleted.length
}

/**
 * The tables `custom_fields` lives on, keyed by object type. A one-directional
 * import: this module knows every carrier so that a definition delete can strip
 * its key from the right table without every object module having to opt in.
 */
const TABLES = {
  person: people,
  company: companies,
  deal: deals,
  opportunity: opportunities,
  partnership: partnerships,
  raise: raises,
  enquiry: enquiries,
} as const

/**
 * Removes one key from every record of one object type in one workspace.
 *
 * Uses `?` to skip rows that never carried the key, so the write set is only
 * the rows that actually held a value. The `-` operator on jsonb returns the
 * object without that key; a key that was not present is a no-op.
 */
export async function stripKeyFromRecords(
  db: Queryable,
  workspaceId: string,
  objectType: CustomFieldObjectType,
  key: string,
): Promise<number> {
  const table = TABLES[objectType]
  const stripped = await db
    .update(table)
    .set({
      customFields: sql`${table.customFields} - ${key}`,
    })
    .where(and(eq(table.workspaceId, workspaceId), sql`${table.customFields} ? ${key}`))
    .returning({ id: table.id })

  return stripped.length
}

/** Bulk row read for a caller that already has a set of ids to update. */
export async function readCustomFieldsById(
  db: Queryable,
  workspaceId: string,
  objectType: CustomFieldObjectType,
  ids: readonly string[],
): Promise<Map<string, Readonly<Record<string, unknown>>>> {
  if (ids.length === 0) {
    return new Map()
  }
  const table = TABLES[objectType]
  const rows = await db
    .select({ id: table.id, customFields: table.customFields })
    .from(table)
    .where(and(eq(table.workspaceId, workspaceId), inArray(table.id, [...ids])))

  return new Map(rows.map((row) => [row.id, row.customFields]))
}
