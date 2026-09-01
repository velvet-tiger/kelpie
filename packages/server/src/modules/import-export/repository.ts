import { and, asc, eq, gt, inArray, sql } from 'drizzle-orm'

import type { CustomFieldValue } from '@kelpie/schemas'
import type { Queryable } from '../../runtime/transaction.ts'
import { users } from '../auth/schema.ts'
import { companies } from '../companies/schema.ts'
import { consentPurposes } from '../consent-purposes/schema.ts'
import { customFieldDefinitions } from '../custom-fields/schema.ts'
import type { CustomFieldDefinitionRecord } from '../custom-fields/repository.ts'
import { deals } from '../deals/schema.ts'
import { enquiries } from '../enquiries/schema.ts'
import { opportunities } from '../opportunities/schema.ts'
import { partnerships } from '../partnerships/schema.ts'
import { people, personConsents, personLinks } from '../people/schema.ts'
import { pipelineStages } from '../pipelines/schema.ts'
import { positions } from '../positions/schema.ts'
import { raises } from '../raises/schema.ts'
import { workspaceMembers } from '../workspace/schema.ts'
import type { MatchKeyParts } from './mapping.ts'
import { importJobRows, importJobs } from './schema.ts'
import type { SettledRowAction } from './schema.ts'

/**
 * Import job storage, the lookups a plan resolves against, and the paged reads
 * an export streams.
 *
 * The lookup functions read the `people`, `companies`, `positions`, `deals`,
 * `pipeline_stages` and `workspace_members` **tables** rather than their
 * repositories. That is the cross-relation rule in `architecture.md`: an import
 * asks one question about ten thousand rows at a time, and composing sibling
 * repositories would answer it one record per round trip.
 */

export type ImportJobRecord = typeof importJobs.$inferSelect
export type ImportJobColumns = typeof importJobs.$inferInsert
export type ImportJobRowRecord = typeof importJobRows.$inferSelect
export type ImportJobRowColumns = typeof importJobRows.$inferInsert

/**
 * The most values to name in one `in (…)`.
 *
 * A ten thousand row file would otherwise build one predicate with ten thousand
 * bound parameters, which postgres.js will send and Postgres will plan badly.
 */
const LOOKUP_CHUNK = 1_000

/** How many records an export reads per round trip. */
export const EXPORT_PAGE = 500

function chunked<T>(values: readonly T[], size: number): readonly (readonly T[])[] {
  const chunks: T[][] = []

  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size))
  }

  return chunks
}

/** Runs `read` over each chunk of `values` and concatenates the results. */
async function overChunks<TValue, TRow>(
  values: readonly TValue[],
  read: (chunk: readonly TValue[]) => Promise<TRow[]>,
): Promise<TRow[]> {
  if (values.length === 0) {
    return []
  }

  const results: TRow[] = []

  for (const chunk of chunked(values, LOOKUP_CHUNK)) {
    results.push(...(await read(chunk)))
  }

  return results
}

export async function insertJob(db: Queryable, values: ImportJobColumns): Promise<ImportJobRecord> {
  const [created] = await db.insert(importJobs).values(values).returning()

  if (created === undefined) {
    throw new Error(`Inserting import job ${values.id} returned no row`)
  }

  return created
}

export async function findJob(
  db: Queryable,
  workspaceId: string,
  id: string,
): Promise<ImportJobRecord | undefined> {
  const [found] = await db
    .select()
    .from(importJobs)
    .where(and(eq(importJobs.workspaceId, workspaceId), eq(importJobs.id, id)))
    .limit(1)

  return found
}

export async function updateJob(
  db: Queryable,
  workspaceId: string,
  id: string,
  changes: Partial<ImportJobColumns>,
): Promise<ImportJobRecord | undefined> {
  const [updated] = await db
    .update(importJobs)
    .set(changes)
    .where(and(eq(importJobs.workspaceId, workspaceId), eq(importJobs.id, id)))
    .returning()

  return updated
}

/**
 * Moves a job from one status to another, and says whether it was there to move.
 *
 * The `from` predicate is what makes a commit safe to race: two requests both
 * reading `ready` will both try this, and only the one whose `UPDATE` matched a
 * row proceeds. Checking the status in a separate `SELECT` first would leave the
 * window between the two open.
 *
 * @returns The moved row, or undefined when the job was in some other status.
 */
export async function moveJobStatus(
  db: Queryable,
  workspaceId: string,
  id: string,
  from: string,
  changes: Partial<ImportJobColumns>,
): Promise<ImportJobRecord | undefined> {
  const [moved] = await db
    .update(importJobs)
    .set(changes)
    .where(
      and(
        eq(importJobs.workspaceId, workspaceId),
        eq(importJobs.id, id),
        eq(importJobs.status, from),
      ),
    )
    .returning()

  return moved
}

/**
 * Removes a job that is in one of `deletableStatuses`, taking its rows with it
 * through the `import_job_rows` cascade.
 *
 * The status lives in the predicate for the same reason it does in
 * `moveJobStatus`: reading the status and then deleting would leave the window
 * between the two open, and what fits in that window is a commit claiming the
 * job and starting to write records against it.
 *
 * @returns How many jobs matched, which is 0 or 1. Zero means the job is gone or
 *   is in a status this delete may not touch, and the caller tells those apart.
 */
export async function deleteJob(
  db: Queryable,
  workspaceId: string,
  id: string,
  deletableStatuses: readonly string[],
): Promise<number> {
  const deleted = await db
    .delete(importJobs)
    .where(
      and(
        eq(importJobs.workspaceId, workspaceId),
        eq(importJobs.id, id),
        inArray(importJobs.status, [...deletableStatuses]),
      ),
    )
    .returning({ id: importJobs.id })

  return deleted.length
}

/** What a commit did to one line. Never `pending`: it has been applied. */
export interface RowOutcome {
  readonly rowNumber: number
  readonly action: SettledRowAction
  readonly errors: readonly { readonly field: string; readonly message: string }[]
  /** Non-fatal notes about a row that was applied anyway, e.g. an unlinked position. */
  readonly warnings: readonly { readonly field: string; readonly message: string }[]
}

/**
 * Records what the commit did to one line, as it does it.
 *
 * `onConflictDoUpdate` on the job and line, so re-running an interrupted commit
 * overwrites the outcome of a line it already reached rather than failing on the
 * primary key. That is the same idempotency the writes themselves have, and
 * without it a commit could not be re-run at all.
 */
export async function recordRowOutcome(
  db: Queryable,
  workspaceId: string,
  jobId: string,
  values: Readonly<Record<string, string>>,
  outcome: RowOutcome,
  now: Date,
): Promise<void> {
  await db
    .insert(importJobRows)
    .values({
      workspaceId,
      jobId,
      rowNumber: outcome.rowNumber,
      values,
      action: outcome.action,
      errors: outcome.errors,
      warnings: outcome.warnings,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [importJobRows.jobId, importJobRows.rowNumber],
      set: {
        action: outcome.action,
        errors: outcome.errors,
        warnings: outcome.warnings,
        updatedAt: now,
      },
    })
}

/** A stored record reduced to what a match key is built from. */
export interface KeyedRecord {
  readonly id: string
  readonly parts: MatchKeyParts
}

interface CompanyKeyRow {
  readonly id: string
  readonly name: string
  readonly domain: string | null
}

const companyKeyColumns = {
  id: companies.id,
  name: companies.name,
  domain: companies.domain,
}

/**
 * Candidates for a company match, by whichever component the key uses.
 *
 * Both filters run because a file can be keyed either way and the caller passes
 * only the values its key needs; the other array is empty and its query never
 * runs. `lower(name) in (…)` rather than `ilike`: a name is caller data, and
 * `ilike` would read a `%` inside one as a wildcard. Same rule as
 * `findCompanyByName`.
 */
export async function findCompanyKeys(
  db: Queryable,
  workspaceId: string,
  domains: readonly string[],
  names: readonly string[],
): Promise<KeyedRecord[]> {
  const byDomain = await overChunks(domains, (chunk): Promise<CompanyKeyRow[]> =>
    db
      .select(companyKeyColumns)
      .from(companies)
      .where(and(eq(companies.workspaceId, workspaceId), inArray(companies.domain, [...chunk]))),
  )

  const byName = await overChunks(names, (chunk): Promise<CompanyKeyRow[]> =>
    db
      .select(companyKeyColumns)
      .from(companies)
      .where(
        and(
          eq(companies.workspaceId, workspaceId),
          inArray(sql<string>`lower(${companies.name})`, [...chunk]),
        ),
      ),
  )

  const unique = new Map<string, CompanyKeyRow>(
    [...byDomain, ...byName].map((row) => [row.id, row]),
  )

  return [...unique.values()].map((row) => ({
    id: row.id,
    parts: { name: row.name, domain: row.domain },
  }))
}

export function findPeopleKeys(
  db: Queryable,
  workspaceId: string,
  emails: readonly string[],
): Promise<KeyedRecord[]> {
  return overChunks(emails, (chunk) =>
    db
      .select({ id: people.id, email: people.email })
      .from(people)
      .where(and(eq(people.workspaceId, workspaceId), inArray(people.email, [...chunk]))),
  ).then((rows) => rows.map((row) => ({ id: row.id, parts: { email: row.email } })))
}

/**
 * Positions held by any of these people, with the address and domain a match key
 * compares on.
 *
 * Filtered by person rather than by both sides: a person has a handful of
 * positions, so this narrows to the same set the domain filter would and needs
 * one join instead of two predicates.
 */
export function findPositionKeys(
  db: Queryable,
  workspaceId: string,
  personEmails: readonly string[],
): Promise<KeyedRecord[]> {
  return overChunks(personEmails, (chunk) =>
    db
      .select({
        id: positions.id,
        title: positions.title,
        personEmail: people.email,
        companyDomain: companies.domain,
      })
      .from(positions)
      .innerJoin(people, eq(people.id, positions.personId))
      .innerJoin(companies, eq(companies.id, positions.companyId))
      .where(and(eq(positions.workspaceId, workspaceId), inArray(people.email, [...chunk]))),
  ).then((rows) =>
    rows.map((row) => ({
      id: row.id,
      parts: {
        title: row.title,
        person_email: row.personEmail,
        company_domain: row.companyDomain,
      },
    })),
  )
}

export function findDealKeysByExternalId(
  db: Queryable,
  workspaceId: string,
  externalIds: readonly string[],
): Promise<KeyedRecord[]> {
  return overChunks(externalIds, (chunk) =>
    db
      .select({ id: deals.id, externalId: deals.externalId })
      .from(deals)
      .where(and(eq(deals.workspaceId, workspaceId), inArray(deals.externalId, [...chunk]))),
  ).then((rows) => rows.map((row) => ({ id: row.id, parts: { external_id: row.externalId } })))
}

export function findDealKeysByCompany(
  db: Queryable,
  workspaceId: string,
  domains: readonly string[],
): Promise<KeyedRecord[]> {
  return overChunks(domains, (chunk) =>
    db
      .select({ id: deals.id, name: deals.name, companyDomain: companies.domain })
      .from(deals)
      .innerJoin(companies, eq(companies.id, deals.companyId))
      .where(and(eq(deals.workspaceId, workspaceId), inArray(companies.domain, [...chunk]))),
  ).then((rows) =>
    rows.map((row) => ({
      id: row.id,
      parts: { name: row.name, company_domain: row.companyDomain },
    })),
  )
}

export function findOpportunityKeysByName(
  db: Queryable,
  workspaceId: string,
  names: readonly string[],
): Promise<KeyedRecord[]> {
  return overChunks(names, (chunk) =>
    db
      .select({ id: opportunities.id, name: opportunities.name })
      .from(opportunities)
      .where(
        and(
          eq(opportunities.workspaceId, workspaceId),
          inArray(sql<string>`lower(${opportunities.name})`, [...chunk]),
        ),
      ),
  ).then((rows) => rows.map((row) => ({ id: row.id, parts: { name: row.name } })))
}

export function findOpportunityKeysByCompany(
  db: Queryable,
  workspaceId: string,
  domains: readonly string[],
): Promise<KeyedRecord[]> {
  return overChunks(domains, (chunk) =>
    db
      .select({ id: opportunities.id, name: opportunities.name, companyDomain: companies.domain })
      .from(opportunities)
      .leftJoin(companies, eq(companies.id, opportunities.companyId))
      .where(and(eq(opportunities.workspaceId, workspaceId), inArray(companies.domain, [...chunk]))),
  ).then((rows) =>
    rows.map((row) => ({
      id: row.id,
      parts: { name: row.name, company_domain: row.companyDomain },
    })),
  )
}

export function findEnquiryKeysByName(
  db: Queryable,
  workspaceId: string,
  names: readonly string[],
): Promise<KeyedRecord[]> {
  return overChunks(names, (chunk) =>
    db
      .select({ id: enquiries.id, name: enquiries.name })
      .from(enquiries)
      .where(
        and(
          eq(enquiries.workspaceId, workspaceId),
          inArray(sql<string>`lower(${enquiries.name})`, [...chunk]),
        ),
      ),
  ).then((rows) => rows.map((row) => ({ id: row.id, parts: { name: row.name } })))
}

export function findEnquiryKeysByCompany(
  db: Queryable,
  workspaceId: string,
  domains: readonly string[],
): Promise<KeyedRecord[]> {
  return overChunks(domains, (chunk) =>
    db
      .select({ id: enquiries.id, name: enquiries.name, companyDomain: companies.domain })
      .from(enquiries)
      .leftJoin(companies, eq(companies.id, enquiries.companyId))
      .where(and(eq(enquiries.workspaceId, workspaceId), inArray(companies.domain, [...chunk]))),
  ).then((rows) =>
    rows.map((row) => ({
      id: row.id,
      parts: { name: row.name, company_domain: row.companyDomain },
    })),
  )
}

export function findPartnershipKeysByCompany(
  db: Queryable,
  workspaceId: string,
  domains: readonly string[],
): Promise<KeyedRecord[]> {
  return overChunks(domains, (chunk) =>
    db
      .select({ id: partnerships.id, name: partnerships.name, companyDomain: companies.domain })
      .from(partnerships)
      .innerJoin(companies, eq(companies.id, partnerships.companyId))
      .where(and(eq(partnerships.workspaceId, workspaceId), inArray(companies.domain, [...chunk]))),
  ).then((rows) =>
    rows.map((row) => ({
      id: row.id,
      parts: { name: row.name, company_domain: row.companyDomain },
    })),
  )
}

export function findRaiseKeysByCompany(
  db: Queryable,
  workspaceId: string,
  domains: readonly string[],
): Promise<KeyedRecord[]> {
  return overChunks(domains, (chunk) =>
    db
      .select({ id: raises.id, name: raises.name, companyDomain: companies.domain })
      .from(raises)
      .innerJoin(companies, eq(companies.id, raises.companyId))
      .where(and(eq(raises.workspaceId, workspaceId), inArray(companies.domain, [...chunk]))),
  ).then((rows) =>
    rows.map((row) => ({
      id: row.id,
      parts: { name: row.name, company_domain: row.companyDomain },
    })),
  )
}

export function findCustomFieldDefinitionKeys(
  db: Queryable,
  workspaceId: string,
  objectTypes: readonly string[],
  keys: readonly string[],
): Promise<KeyedRecord[]> {
  if (objectTypes.length === 0 || keys.length === 0) {
    return Promise.resolve([])
  }

  return db
    .select({
      id: customFieldDefinitions.id,
      objectType: customFieldDefinitions.objectType,
      key: customFieldDefinitions.key,
    })
    .from(customFieldDefinitions)
    .where(
      and(
        eq(customFieldDefinitions.workspaceId, workspaceId),
        inArray(customFieldDefinitions.objectType, [...objectTypes]),
        inArray(customFieldDefinitions.key, [...keys]),
      ),
    )
    .then((rows) =>
      rows.map((row) => ({
        id: row.id,
        parts: { object_type: row.objectType, key: row.key },
      })),
    )
}

export function findPersonIdsByEmail(
  db: Queryable,
  workspaceId: string,
  emails: readonly string[],
): Promise<{ email: string | null; id: string }[]> {
  return overChunks(emails, (chunk) =>
    db
      .select({ id: people.id, email: people.email })
      .from(people)
      .where(and(eq(people.workspaceId, workspaceId), inArray(people.email, [...chunk]))),
  )
}

export function findCompanyIdsByDomain(
  db: Queryable,
  workspaceId: string,
  domains: readonly string[],
): Promise<{ domain: string | null; id: string }[]> {
  return overChunks(domains, (chunk) =>
    db
      .select({ id: companies.id, domain: companies.domain })
      .from(companies)
      .where(and(eq(companies.workspaceId, workspaceId), inArray(companies.domain, [...chunk]))),
  )
}

/**
 * Company ids by folded name, for a People affiliation matched on a company
 * name rather than a domain.
 *
 * `lower(name) in (…)` rather than `ilike`, so a `%` inside a caller-supplied
 * name is a literal, not a wildcard. The same rule `findCompanyKeys` follows.
 * The caller passes names already lowercased.
 */
export function findCompanyIdsByName(
  db: Queryable,
  workspaceId: string,
  names: readonly string[],
): Promise<{ name: string; id: string }[]> {
  return overChunks(names, (chunk) =>
    db
      .select({ id: companies.id, name: companies.name })
      .from(companies)
      .where(
        and(
          eq(companies.workspaceId, workspaceId),
          inArray(sql<string>`lower(${companies.name})`, [...chunk]),
        ),
      ),
  )
}

/** Every member of the workspace, by the address of the user behind them. */
export function listMemberEmails(
  db: Queryable,
  workspaceId: string,
): Promise<{ id: string; email: string }[]> {
  return db
    .select({ id: workspaceMembers.id, email: users.email })
    .from(workspaceMembers)
    .innerJoin(users, eq(users.id, workspaceMembers.userId))
    .where(eq(workspaceMembers.workspaceId, workspaceId))
}

/** A pipeline's stages, for resolving a stage name in a row. */
export function listPipelineStages(
  db: Queryable,
  workspaceId: string,
  kind: import('../pipelines/schema.ts').PipelineKind,
): Promise<{ id: string; slug: string; label: string }[]> {
  return db
    .select({ id: pipelineStages.id, slug: pipelineStages.slug, label: pipelineStages.label })
    .from(pipelineStages)
    .where(and(eq(pipelineStages.workspaceId, workspaceId), eq(pipelineStages.kind, kind)))
    .orderBy(asc(pipelineStages.sortOrder), asc(pipelineStages.id))
}

/** @deprecated Use `listPipelineStages` with kind `deal`. */
export function listDealStages(
  db: Queryable,
  workspaceId: string,
): Promise<{ id: string; slug: string; label: string }[]> {
  return listPipelineStages(db, workspaceId, 'deal')
}

/* Export readers. Keyset by id, which is a ULID and therefore creation order. */

export interface ExportCompanyRow {
  readonly id: string
  readonly name: string
  readonly domain: string | null
  readonly industry: string | null
  readonly stage: string
  readonly sizeBand: string
  readonly accountType: string
  readonly icpFit: string
  readonly description: string
  readonly summary: string
  readonly tags: readonly string[]
  readonly website: string | null
  readonly hq: string | null
  readonly customFields: Readonly<Record<string, CustomFieldValue>>
}

export function readCompanies(
  db: Queryable,
  workspaceId: string,
  after: string,
): Promise<ExportCompanyRow[]> {
  return db
    .select({
      id: companies.id,
      name: companies.name,
      domain: companies.domain,
      industry: companies.industry,
      stage: companies.stage,
      sizeBand: companies.sizeBand,
      accountType: companies.accountType,
      icpFit: companies.icpFit,
      description: companies.description,
      summary: companies.summary,
      tags: companies.tags,
      website: companies.website,
      hq: companies.hq,
      customFields: companies.customFields,
    })
    .from(companies)
    .where(and(eq(companies.workspaceId, workspaceId), gt(companies.id, after)))
    .orderBy(asc(companies.id))
    .limit(EXPORT_PAGE)
}

export interface ExportPersonRow {
  readonly id: string
  readonly name: string
  readonly salutation: string | null
  readonly firstName: string | null
  readonly lastName: string | null
  readonly suffix: string | null
  readonly email: string | null
  readonly timezone: string | null
  readonly location: string | null
  readonly preferredChannel: string
  readonly influence: string
  readonly relationship: string
  readonly summary: string
  readonly tags: readonly string[]
  readonly phones: readonly string[]
  readonly doNotContact: boolean
  /**
   * `<purpose_slug>:<status>` pairs joined with '; ', in purpose sort order.
   * Purposes at their default (no explicit `person_consents` row) are omitted.
   */
  readonly consents: string
  readonly customFields: Readonly<Record<string, CustomFieldValue>>
}

export async function readPeople(
  db: Queryable,
  workspaceId: string,
  after: string,
): Promise<ExportPersonRow[]> {
  const rows = await db
    .select({
      id: people.id,
      name: people.name,
      salutation: people.salutation,
      firstName: people.firstName,
      lastName: people.lastName,
      suffix: people.suffix,
      email: people.email,
      timezone: people.timezone,
      location: people.location,
      preferredChannel: people.preferredChannel,
      influence: people.influence,
      relationship: people.relationship,
      summary: people.summary,
      tags: people.tags,
      phones: people.phones,
      doNotContact: people.doNotContact,
      customFields: people.customFields,
    })
    .from(people)
    .where(and(eq(people.workspaceId, workspaceId), gt(people.id, after)))
    .orderBy(asc(people.id))
    .limit(EXPORT_PAGE)

  if (rows.length === 0) return []
  const consentsByPerson = await readConsentsForExport(
    db,
    workspaceId,
    rows.map((row) => row.id),
  )
  return rows.map((row) => ({
    ...row,
    consents: consentsByPerson.get(row.id) ?? '',
  }))
}

async function readConsentsForExport(
  db: Queryable,
  workspaceId: string,
  personIds: readonly string[],
): Promise<ReadonlyMap<string, string>> {
  const rows = await db
    .select({
      personId: personConsents.personId,
      slug: consentPurposes.slug,
      status: personConsents.status,
      sortOrder: consentPurposes.sortOrder,
    })
    .from(personConsents)
    .innerJoin(consentPurposes, eq(consentPurposes.id, personConsents.purposeId))
    .where(
      and(
        eq(personConsents.workspaceId, workspaceId),
        inArray(personConsents.personId, [...personIds]),
      ),
    )
    .orderBy(asc(consentPurposes.sortOrder), asc(consentPurposes.slug))

  const out = new Map<string, string[]>()
  for (const row of rows) {
    const list = out.get(row.personId) ?? []
    list.push(`${row.slug}:${row.status}`)
    out.set(row.personId, list)
  }
  return new Map(Array.from(out, ([personId, list]) => [personId, list.join('; ')]))
}

export interface ExportPositionRow {
  readonly id: string
  readonly personEmail: string | null
  readonly companyDomain: string | null
  readonly title: string
}

export function readPositions(
  db: Queryable,
  workspaceId: string,
  after: string,
): Promise<ExportPositionRow[]> {
  return db
    .select({
      id: positions.id,
      personEmail: people.email,
      companyDomain: companies.domain,
      title: positions.title,
    })
    .from(positions)
    .innerJoin(people, eq(people.id, positions.personId))
    .innerJoin(companies, eq(companies.id, positions.companyId))
    .where(and(eq(positions.workspaceId, workspaceId), gt(positions.id, after)))
    .orderBy(asc(positions.id))
    .limit(EXPORT_PAGE)
}

export interface ExportDealRow {
  readonly id: string
  readonly name: string
  readonly companyDomain: string | null
  readonly stageSlug: string
  readonly valueCents: number | null
  readonly ownerEmail: string | null
  readonly expectedClose: string | null
  readonly competitors: readonly string[]
  readonly risks: string
  readonly whyWin: string
  readonly summary: string
  readonly tags: readonly string[]
  readonly externalId: string | null
  readonly customFields: Readonly<Record<string, CustomFieldValue>>
}

/**
 * `owner_email` comes from a left join: a deal may have no owner, and an inner
 * join would drop it from the export rather than leave the column empty.
 */
export function readDeals(
  db: Queryable,
  workspaceId: string,
  after: string,
): Promise<ExportDealRow[]> {
  return db
    .select({
      id: deals.id,
      name: deals.name,
      companyDomain: companies.domain,
      stageSlug: pipelineStages.slug,
      valueCents: deals.valueCents,
      ownerEmail: users.email,
      expectedClose: deals.expectedClose,
      competitors: deals.competitors,
      risks: deals.risks,
      whyWin: deals.whyWin,
      summary: deals.summary,
      tags: deals.tags,
      externalId: deals.externalId,
      customFields: deals.customFields,
    })
    .from(deals)
    .innerJoin(companies, eq(companies.id, deals.companyId))
    .innerJoin(pipelineStages, eq(pipelineStages.id, deals.stageId))
    .leftJoin(workspaceMembers, eq(workspaceMembers.id, deals.ownerId))
    .leftJoin(users, eq(users.id, workspaceMembers.userId))
    .where(and(eq(deals.workspaceId, workspaceId), gt(deals.id, after)))
    .orderBy(asc(deals.id))
    .limit(EXPORT_PAGE)
}

/** The addresses of the people linked to each of a page of pipeline records. */
export async function readLinkedPersonEmails(
  db: Queryable,
  workspaceId: string,
  targetType: string,
  targetIds: readonly string[],
): Promise<ReadonlyMap<string, readonly string[]>> {
  if (targetIds.length === 0) {
    return new Map()
  }

  const rows = await db
    .select({ targetId: personLinks.targetId, email: people.email })
    .from(personLinks)
    .innerJoin(people, eq(people.id, personLinks.personId))
    .where(
      and(
        eq(personLinks.workspaceId, workspaceId),
        eq(personLinks.targetType, targetType),
        inArray(personLinks.targetId, [...targetIds]),
      ),
    )
    .orderBy(asc(people.email))

  const byTarget = new Map<string, string[]>()

  for (const row of rows) {
    if (row.email === null) {
      continue
    }

    const existing = byTarget.get(row.targetId)

    if (existing === undefined) {
      byTarget.set(row.targetId, [row.email])
    } else {
      existing.push(row.email)
    }
  }

  return byTarget
}

/** @deprecated Use {@link readLinkedPersonEmails} with `targetType: 'deal'`. */
export async function readDealPersonEmails(
  db: Queryable,
  workspaceId: string,
  dealIds: readonly string[],
): Promise<ReadonlyMap<string, readonly string[]>> {
  return readLinkedPersonEmails(db, workspaceId, 'deal', dealIds)
}

interface PipelineExportRow {
  readonly id: string
  readonly name: string
  readonly companyDomain: string | null
  readonly stageSlug: string
  readonly ownerEmail: string | null
  readonly summary: string
  readonly tags: readonly string[]
  readonly customFields: Readonly<Record<string, CustomFieldValue>>
}

export interface ExportOpportunityRow extends PipelineExportRow {
  readonly kind: string
  readonly expectedClose: string | null
}

export function readOpportunities(
  db: Queryable,
  workspaceId: string,
  after: string,
): Promise<ExportOpportunityRow[]> {
  return db
    .select({
      id: opportunities.id,
      name: opportunities.name,
      kind: opportunities.kind,
      companyDomain: companies.domain,
      stageSlug: pipelineStages.slug,
      ownerEmail: users.email,
      expectedClose: opportunities.expectedClose,
      summary: opportunities.summary,
      tags: opportunities.tags,
      customFields: opportunities.customFields,
    })
    .from(opportunities)
    .leftJoin(companies, eq(companies.id, opportunities.companyId))
    .innerJoin(pipelineStages, eq(pipelineStages.id, opportunities.stageId))
    .leftJoin(workspaceMembers, eq(workspaceMembers.id, opportunities.ownerId))
    .leftJoin(users, eq(users.id, workspaceMembers.userId))
    .where(and(eq(opportunities.workspaceId, workspaceId), gt(opportunities.id, after)))
    .orderBy(asc(opportunities.id))
    .limit(EXPORT_PAGE)
}

export interface ExportEnquiryRow extends PipelineExportRow {
  readonly source: string
}

export function readEnquiries(
  db: Queryable,
  workspaceId: string,
  after: string,
): Promise<ExportEnquiryRow[]> {
  return db
    .select({
      id: enquiries.id,
      name: enquiries.name,
      source: enquiries.source,
      companyDomain: companies.domain,
      stageSlug: pipelineStages.slug,
      ownerEmail: users.email,
      summary: enquiries.summary,
      tags: enquiries.tags,
      customFields: enquiries.customFields,
    })
    .from(enquiries)
    .leftJoin(companies, eq(companies.id, enquiries.companyId))
    .innerJoin(pipelineStages, eq(pipelineStages.id, enquiries.stageId))
    .leftJoin(workspaceMembers, eq(workspaceMembers.id, enquiries.ownerId))
    .leftJoin(users, eq(users.id, workspaceMembers.userId))
    .where(and(eq(enquiries.workspaceId, workspaceId), gt(enquiries.id, after)))
    .orderBy(asc(enquiries.id))
    .limit(EXPORT_PAGE)
}

export interface ExportPartnershipRow extends PipelineExportRow {
  readonly kind: string
  readonly nextTouchpoint: string | null
  readonly goals: string
  readonly successLooksLike: string
}

export function readPartnerships(
  db: Queryable,
  workspaceId: string,
  after: string,
): Promise<ExportPartnershipRow[]> {
  return db
    .select({
      id: partnerships.id,
      name: partnerships.name,
      companyDomain: companies.domain,
      stageSlug: pipelineStages.slug,
      kind: partnerships.kind,
      nextTouchpoint: partnerships.nextTouchpoint,
      ownerEmail: users.email,
      goals: partnerships.goals,
      successLooksLike: partnerships.successLooksLike,
      summary: partnerships.summary,
      tags: partnerships.tags,
      customFields: partnerships.customFields,
    })
    .from(partnerships)
    .innerJoin(companies, eq(companies.id, partnerships.companyId))
    .innerJoin(pipelineStages, eq(pipelineStages.id, partnerships.stageId))
    .leftJoin(workspaceMembers, eq(workspaceMembers.id, partnerships.ownerId))
    .leftJoin(users, eq(users.id, workspaceMembers.userId))
    .where(and(eq(partnerships.workspaceId, workspaceId), gt(partnerships.id, after)))
    .orderBy(asc(partnerships.id))
    .limit(EXPORT_PAGE)
}

export interface ExportRaiseRow extends PipelineExportRow {
  readonly checkSizeCents: number | null
  readonly currency: string | null
  readonly thesisFit: string
  readonly passReason: string | null
  readonly expectedClose: string | null
}

export function readRaises(
  db: Queryable,
  workspaceId: string,
  after: string,
): Promise<ExportRaiseRow[]> {
  return db
    .select({
      id: raises.id,
      name: raises.name,
      companyDomain: companies.domain,
      stageSlug: pipelineStages.slug,
      checkSizeCents: raises.checkSizeCents,
      currency: raises.currency,
      thesisFit: raises.thesisFit,
      passReason: raises.passReason,
      ownerEmail: users.email,
      expectedClose: raises.expectedClose,
      summary: raises.summary,
      tags: raises.tags,
      customFields: raises.customFields,
    })
    .from(raises)
    .innerJoin(companies, eq(companies.id, raises.companyId))
    .innerJoin(pipelineStages, eq(pipelineStages.id, raises.stageId))
    .leftJoin(workspaceMembers, eq(workspaceMembers.id, raises.ownerId))
    .leftJoin(users, eq(users.id, workspaceMembers.userId))
    .where(and(eq(raises.workspaceId, workspaceId), gt(raises.id, after)))
    .orderBy(asc(raises.id))
    .limit(EXPORT_PAGE)
}

export function readCustomFieldDefinitions(
  db: Queryable,
  workspaceId: string,
  after: string,
): Promise<CustomFieldDefinitionRecord[]> {
  return db
    .select()
    .from(customFieldDefinitions)
    .where(
      and(eq(customFieldDefinitions.workspaceId, workspaceId), gt(customFieldDefinitions.id, after)),
    )
    .orderBy(asc(customFieldDefinitions.id))
    .limit(EXPORT_PAGE)
}
