import type { ConsentPurposeStatus } from '@kelpie/schemas'
import { and, asc, eq, inArray } from 'drizzle-orm'

import type { Queryable } from '../../runtime/transaction.ts'
import { consentPurposes } from '../consent-purposes/schema.ts'
import { personConsents } from './schema.ts'

/**
 * Merges a workspace's consent purposes with any explicit `person_consents`
 * rows into the effective status agents and humans read on a Person.
 *
 * The rule is simple: an explicit row wins; absence means "inherits the
 * purpose's `default_status`". This helper does the join and the merge in one
 * place so every read of a Person resolves it the same way.
 */

export interface EffectiveConsent {
  readonly purposeSlug: string
  readonly purposeLabel: string
  readonly status: ConsentPurposeStatus
  readonly source: string | null
  readonly notedAt: Date | null
  readonly inherited: boolean
}

/** The workspace purposes and any person-level rows, in one shape. */
interface PurposeRow {
  readonly id: string
  readonly slug: string
  readonly label: string
  readonly defaultStatus: ConsentPurposeStatus
  readonly sortOrder: number
}

interface PersonConsentRow {
  readonly personId: string
  readonly purposeId: string
  readonly status: 'granted' | 'withdrawn'
  readonly source: string
  readonly notedAt: Date
}

async function loadPurposes(
  db: Queryable,
  workspaceId: string,
): Promise<readonly PurposeRow[]> {
  const rows = await db
    .select({
      id: consentPurposes.id,
      slug: consentPurposes.slug,
      label: consentPurposes.label,
      defaultStatus: consentPurposes.defaultStatus,
      sortOrder: consentPurposes.sortOrder,
    })
    .from(consentPurposes)
    .where(eq(consentPurposes.workspaceId, workspaceId))
    .orderBy(asc(consentPurposes.sortOrder), asc(consentPurposes.id))

  return rows.map((row) => ({
    id: row.id,
    slug: row.slug,
    label: row.label,
    defaultStatus: row.defaultStatus as ConsentPurposeStatus,
    sortOrder: row.sortOrder,
  }))
}

async function loadConsentsFor(
  db: Queryable,
  workspaceId: string,
  personIds: readonly string[],
): Promise<readonly PersonConsentRow[]> {
  if (personIds.length === 0) return []
  const rows = await db
    .select({
      personId: personConsents.personId,
      purposeId: personConsents.purposeId,
      status: personConsents.status,
      source: personConsents.source,
      notedAt: personConsents.notedAt,
    })
    .from(personConsents)
    .where(
      and(
        eq(personConsents.workspaceId, workspaceId),
        inArray(personConsents.personId, [...personIds]),
      ),
    )

  return rows.map((row) => ({
    personId: row.personId,
    purposeId: row.purposeId,
    status: row.status as 'granted' | 'withdrawn',
    source: row.source,
    notedAt: row.notedAt,
  }))
}

function mergeFor(
  purposes: readonly PurposeRow[],
  explicitByPurpose: ReadonlyMap<string, PersonConsentRow>,
): readonly EffectiveConsent[] {
  return purposes.map((purpose) => {
    const explicit = explicitByPurpose.get(purpose.id)
    if (explicit === undefined) {
      return {
        purposeSlug: purpose.slug,
        purposeLabel: purpose.label,
        status: purpose.defaultStatus,
        source: null,
        notedAt: null,
        inherited: true,
      }
    }
    return {
      purposeSlug: purpose.slug,
      purposeLabel: purpose.label,
      status: explicit.status,
      source: explicit.source,
      notedAt: explicit.notedAt,
      inherited: false,
    }
  })
}

/** Consents for one person. */
export async function readConsentsFor(
  db: Queryable,
  workspaceId: string,
  personId: string,
): Promise<readonly EffectiveConsent[]> {
  const [purposes, explicit] = await Promise.all([
    loadPurposes(db, workspaceId),
    loadConsentsFor(db, workspaceId, [personId]),
  ])
  const byPurpose = new Map(explicit.map((row) => [row.purposeId, row]))
  return mergeFor(purposes, byPurpose)
}

/**
 * Consents for many people. Loads purposes once and person rows once, then
 * merges in memory — cheaper than a per-row read for a paged list.
 */
export async function readConsentsForMany(
  db: Queryable,
  workspaceId: string,
  personIds: readonly string[],
): Promise<ReadonlyMap<string, readonly EffectiveConsent[]>> {
  if (personIds.length === 0) return new Map()
  const [purposes, explicit] = await Promise.all([
    loadPurposes(db, workspaceId),
    loadConsentsFor(db, workspaceId, personIds),
  ])

  const byPerson = new Map<string, Map<string, PersonConsentRow>>()
  for (const row of explicit) {
    const map = byPerson.get(row.personId) ?? new Map<string, PersonConsentRow>()
    map.set(row.purposeId, row)
    byPerson.set(row.personId, map)
  }

  const out = new Map<string, readonly EffectiveConsent[]>()
  for (const personId of personIds) {
    out.set(personId, mergeFor(purposes, byPerson.get(personId) ?? new Map()))
  }
  return out
}
