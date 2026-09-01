import type {
  ConsentStatus,
  ImportConflictMode,
  ImportCounts,
  ImportObject,
  MatchKeyOption,
  OnMissingCompany,
  PipelineKind,
} from '@kelpie/schemas'
import { pipelineKindForImport } from '@kelpie/schemas'

import { normaliseDomain, normaliseEmail } from '../../lib/normalisation.ts'
import type { CustomFieldDefinitionRecord } from '../custom-fields/repository.ts'
import {
  customFieldWireValues,
  extractCustomFieldRaw,
} from './customFieldImport.ts'
import {
  affiliationCompanyDraft,
  companyDraft,
  customFieldDefinitionDraft,
  dealFieldsDraft,
  enquiryFieldsDraft,
  opportunityFieldsDraft,
  partnershipFieldsDraft,
  personDraft,
  raiseFieldsDraft,
} from './drafts.ts'
import type {
  CompanyDraft,
  CustomFieldDefinitionDraft,
  DealFieldsDraft,
  EnquiryFieldsDraft,
  OpportunityFieldsDraft,
  PartnershipFieldsDraft,
  PersonDraft,
  RaiseFieldsDraft,
} from './drafts.ts'
import { buildMatchKey, splitList } from './mapping.ts'
import { aliasedStageSlug } from './presets.ts'
import type { StoredRowError } from './schema.ts'
import { validateRow } from './validation.ts'

/**
 * What a row would do, and to what.
 *
 * The dry run and the commit both go through here. The difference is where the
 * lookups come from: a dry run passes one snapshot taken over the whole file, a
 * commit passes what it just read inside its transaction. One planner means the
 * commit cannot decide something the preview never showed.
 *
 * Pure. Every lookup arrives as a map.
 */

export interface ImportLookups {
  /** Match key → the id of the record already holding it. */
  readonly existing: ReadonlyMap<string, string>
  readonly personIdByEmail: ReadonlyMap<string, string>
  readonly companyIdByDomain: ReadonlyMap<string, string>
  /** Company id by its folded name, for a People affiliation matched by name. */
  readonly companyIdByName: ReadonlyMap<string, string>
  /** Workspace member id by the address of the user behind it. */
  readonly memberIdByEmail: ReadonlyMap<string, string>
  /** Pipeline stage id, keyed by both its slug and its folded label. */
  readonly stageIdByName: ReadonlyMap<string, string>
}

export interface PlanContext {
  readonly object: ImportObject
  readonly matchKey: MatchKeyOption
  readonly conflictMode: ImportConflictMode
  /** What a People row does with an absent company. Ignored by the other objects. */
  readonly onMissingCompany: OnMissingCompany
  /** The consent purpose the job grants for each row's consent_status. Null when not set. */
  readonly consentPurposeId: string | null
  readonly lookups: ImportLookups
  /** Workspace custom field definitions when the object carries custom field values. */
  readonly customFieldDefinitions: readonly CustomFieldDefinitionRecord[]
  readonly baseColumnKeys: ReadonlySet<string>
}

/**
 * A company affiliation a People row asks for: the position to write, and
 * whether the company must be created before it can be linked.
 */
export type PlannedAffiliation =
  | { readonly kind: 'link'; readonly companyId: string; readonly title: string }
  | { readonly kind: 'create'; readonly company: CompanyDraft; readonly title: string }

/** A consent write that rides with a People row when the job has a purpose. */
export interface ImportConsentGrant {
  readonly purposeId: string
  readonly status: ConsentStatus
  /** ISO date from the `consent_at` column; null when the column is unmapped or blank. */
  readonly notedAt: string | null
}

/** The values a write applies, once every reference in the row has been resolved. */
export type ImportWrite =
  | { readonly object: 'companies'; readonly draft: CompanyDraft }
  | {
      readonly object: 'people'
      readonly draft: PersonDraft
      /** A position to upsert alongside the person, when the row named a company and a title. */
      readonly affiliation?: PlannedAffiliation
      /** Consent to grant against the job's purpose. Absent when consent_status is blank. */
      readonly consent?: ImportConsentGrant
    }
  | {
      readonly object: 'positions'
      readonly personId: string
      readonly companyId: string
      readonly title: string
    }
  | {
      readonly object: 'deals'
      readonly draft: DealFieldsDraft
      readonly companyId: string
      readonly stageId: string
      readonly ownerId: string | null
      readonly personIds: readonly string[]
      readonly setsPeople: boolean
    }
  | {
      readonly object: 'opportunities'
      readonly draft: OpportunityFieldsDraft
      readonly companyId: string | null
      readonly stageId: string
      readonly ownerId: string | null
      readonly personIds: readonly string[]
      readonly setsPeople: boolean
    }
  | {
      readonly object: 'enquiries'
      readonly draft: EnquiryFieldsDraft
      readonly companyId: string | null
      readonly stageId: string
      readonly ownerId: string | null
      readonly personIds: readonly string[]
      readonly setsPeople: boolean
    }
  | {
      readonly object: 'partnerships'
      readonly draft: PartnershipFieldsDraft
      readonly companyId: string
      readonly stageId: string
      readonly ownerId: string | null
      readonly personIds: readonly string[]
      readonly setsPeople: boolean
    }
  | {
      readonly object: 'raises'
      readonly draft: RaiseFieldsDraft
      readonly companyId: string
      readonly stageId: string
      readonly ownerId: string | null
      readonly personIds: readonly string[]
      readonly setsPeople: boolean
    }
  | { readonly object: 'custom_fields'; readonly draft: CustomFieldDefinitionDraft }

export type RowPlan =
  | { readonly action: 'error'; readonly errors: readonly StoredRowError[] }
  /**
   * `targetId` is null when the row matched an earlier row of the same file
   * rather than a stored record. A dry run only counts it; by the time a commit
   * reaches the row the earlier one has been written, so it resolves to an id.
   */
  | { readonly action: 'skip'; readonly key: string; readonly targetId: string | null }
  | {
      readonly action: 'create'
      readonly key: string
      readonly write: ImportWrite
      /** Non-fatal notes about the applied row, e.g. a People affiliation left unlinked. */
      readonly warnings?: readonly StoredRowError[]
    }
  | {
      readonly action: 'update'
      readonly key: string
      readonly targetId: string | null
      readonly write: ImportWrite
      readonly warnings?: readonly StoredRowError[]
    }

export interface PlannedRow {
  readonly row: number
  readonly plan: RowPlan
}

/** A row as the planner takes it: the file line, and the row mapped to Kelpie columns. */
export interface MappedRow {
  readonly row: number
  readonly mapped: Readonly<Record<string, string>>
}

function error(...errors: readonly StoredRowError[]): RowPlan {
  return { action: 'error', errors }
}

function customFieldsForRow(
  context: PlanContext,
  mapped: Readonly<Record<string, string>>,
): Readonly<Record<string, import('@kelpie/schemas').CustomFieldWireValue>> {
  const raw = extractCustomFieldRaw(mapped, context.baseColumnKeys)

  return customFieldWireValues(raw, context.customFieldDefinitions)
}

const PIPELINE_LABEL: Readonly<Record<PipelineKind, string>> = {
  deal: 'deal',
  opportunity: 'opportunity',
  enquiry: 'enquiry',
  partnership: 'partnership',
  raise: 'fundraising',
}

/**
 * The stage a pipeline row names, as a stage of this workspace.
 *
 * Its own slug first, then its label, then the vendor alias table for deals.
 */
function resolveStageId(context: PlanContext, raw: string): string | undefined {
  const folded = raw.trim().toLowerCase()
  const direct = context.lookups.stageIdByName.get(folded)

  if (direct !== undefined) {
    return direct
  }

  const kind = pipelineKindForImport(context.object)

  if (kind === 'deal') {
    const aliased = aliasedStageSlug(raw)

    return aliased === undefined ? undefined : context.lookups.stageIdByName.get(aliased)
  }

  return undefined
}

function pipelineStageError(context: PlanContext, raw: string): StoredRowError {
  const kind = pipelineKindForImport(context.object)
  const label = kind === null ? 'pipeline' : PIPELINE_LABEL[kind]

  return {
    field: 'stage',
    message: `"${raw.trim()}" is not a stage of this workspace's ${label} pipeline`,
  }
}

interface ResolvedPeople {
  readonly ownerId: string | null
  readonly personIds: readonly string[]
  readonly setsPeople: boolean
  readonly problems: readonly StoredRowError[]
}

function resolveOwnerAndPeople(
  context: PlanContext,
  mapped: Readonly<Record<string, string>>,
): ResolvedPeople {
  const problems: StoredRowError[] = []
  const ownerEmail = normaliseEmail(mapped.owner_email ?? '')
  const ownerId = ownerEmail === null ? null : (context.lookups.memberIdByEmail.get(ownerEmail) ?? null)

  if (ownerEmail !== null && ownerId === null) {
    problems.push({
      field: 'owner_email',
      message: `Nobody in this workspace is ${ownerEmail}. Leave the column unmapped to import without owners`,
    })
  }

  const personIds: string[] = []

  for (const raw of splitList(mapped.person_emails)) {
    const address = normaliseEmail(raw)
    const personId = address === null ? undefined : context.lookups.personIdByEmail.get(address)

    if (personId === undefined) {
      problems.push({ field: 'person_emails', message: `No person here has the address ${raw}` })
      continue
    }

    personIds.push(personId)
  }

  return {
    ownerId,
    personIds: [...new Set(personIds)],
    setsPeople: (mapped.person_emails ?? '').trim().length > 0,
    problems,
  }
}

function resolveCompanyId(
  context: PlanContext,
  mapped: Readonly<Record<string, string>>,
  required: boolean,
): { readonly companyId: string | null; readonly problems: readonly StoredRowError[] } {
  const problems: StoredRowError[] = []
  const domainRaw = (mapped.company_domain ?? '').trim()

  if (domainRaw.length === 0) {
    if (required) {
      problems.push({
        field: 'company_domain',
        message: 'No company here has that domain. Import companies first',
      })
    }

    return { companyId: null, problems }
  }

  const domain = normaliseDomain(domainRaw)
  const companyId = domain === null ? undefined : context.lookups.companyIdByDomain.get(domain)

  if (companyId === undefined) {
    problems.push({
      field: 'company_domain',
      message: 'No company here has that domain. Import companies first',
    })
  }

  return { companyId: companyId ?? null, problems }
}

function planPosition(context: PlanContext, mapped: Readonly<Record<string, string>>): ImportWrite | RowPlan {
  const email = normaliseEmail(mapped.person_email ?? '')
  const domain = normaliseDomain(mapped.company_domain ?? '')
  const personId = email === null ? undefined : context.lookups.personIdByEmail.get(email)
  const companyId = domain === null ? undefined : context.lookups.companyIdByDomain.get(domain)
  const problems: StoredRowError[] = []

  if (personId === undefined) {
    problems.push({ field: 'person_email', message: 'No person here has that address. Import people first' })
  }

  if (companyId === undefined) {
    problems.push({
      field: 'company_domain',
      message: 'No company here has that domain. Import companies first',
    })
  }

  if (personId === undefined || companyId === undefined) {
    return error(...problems)
  }

  return { object: 'positions', personId, companyId, title: (mapped.title ?? '').trim() }
}

function planDeal(context: PlanContext, mapped: Readonly<Record<string, string>>): ImportWrite | RowPlan {
  const customFields = customFieldsForRow(context, mapped)
  const { companyId, problems: companyProblems } = resolveCompanyId(context, mapped, true)
  const stageId = resolveStageId(context, mapped.stage ?? '')
  const people = resolveOwnerAndPeople(context, mapped)
  const problems = [...companyProblems, ...people.problems]

  if (stageId === undefined) {
    problems.push(pipelineStageError(context, mapped.stage ?? ''))
  }

  if (problems.length > 0 || companyId === null || stageId === undefined) {
    return error(...problems)
  }

  return {
    object: 'deals',
    draft: dealFieldsDraft(mapped, customFields),
    companyId,
    stageId,
    ownerId: people.ownerId,
    personIds: people.personIds,
    setsPeople: people.setsPeople,
  }
}

function planOpportunity(
  context: PlanContext,
  mapped: Readonly<Record<string, string>>,
): ImportWrite | RowPlan {
  const customFields = customFieldsForRow(context, mapped)
  const { companyId, problems: companyProblems } = resolveCompanyId(context, mapped, false)
  const stageId = resolveStageId(context, mapped.stage ?? '')
  const people = resolveOwnerAndPeople(context, mapped)
  const problems = [...companyProblems, ...people.problems]

  if (stageId === undefined) {
    problems.push(pipelineStageError(context, mapped.stage ?? ''))
  }

  if (problems.length > 0 || stageId === undefined) {
    return error(...problems)
  }

  return {
    object: 'opportunities',
    draft: opportunityFieldsDraft(mapped, customFields),
    companyId,
    stageId,
    ownerId: people.ownerId,
    personIds: people.personIds,
    setsPeople: people.setsPeople,
  }
}

function planEnquiry(context: PlanContext, mapped: Readonly<Record<string, string>>): ImportWrite | RowPlan {
  const customFields = customFieldsForRow(context, mapped)
  const { companyId, problems: companyProblems } = resolveCompanyId(context, mapped, false)
  const stageId = resolveStageId(context, mapped.stage ?? '')
  const people = resolveOwnerAndPeople(context, mapped)
  const problems = [...companyProblems, ...people.problems]

  if (stageId === undefined) {
    problems.push(pipelineStageError(context, mapped.stage ?? ''))
  }

  if (problems.length > 0 || stageId === undefined) {
    return error(...problems)
  }

  return {
    object: 'enquiries',
    draft: enquiryFieldsDraft(mapped, customFields),
    companyId,
    stageId,
    ownerId: people.ownerId,
    personIds: people.personIds,
    setsPeople: people.setsPeople,
  }
}

function planPartnership(
  context: PlanContext,
  mapped: Readonly<Record<string, string>>,
): ImportWrite | RowPlan {
  const customFields = customFieldsForRow(context, mapped)
  const { companyId, problems: companyProblems } = resolveCompanyId(context, mapped, true)
  const stageId = resolveStageId(context, mapped.stage ?? '')
  const people = resolveOwnerAndPeople(context, mapped)
  const problems = [...companyProblems, ...people.problems]

  if (stageId === undefined) {
    problems.push(pipelineStageError(context, mapped.stage ?? ''))
  }

  if (problems.length > 0 || companyId === null || stageId === undefined) {
    return error(...problems)
  }

  return {
    object: 'partnerships',
    draft: partnershipFieldsDraft(mapped, customFields),
    companyId,
    stageId,
    ownerId: people.ownerId,
    personIds: people.personIds,
    setsPeople: people.setsPeople,
  }
}

function planRaise(context: PlanContext, mapped: Readonly<Record<string, string>>): ImportWrite | RowPlan {
  const customFields = customFieldsForRow(context, mapped)
  const { companyId, problems: companyProblems } = resolveCompanyId(context, mapped, true)
  const stageId = resolveStageId(context, mapped.stage ?? '')
  const people = resolveOwnerAndPeople(context, mapped)
  const problems = [...companyProblems, ...people.problems]

  if (stageId === undefined) {
    problems.push(pipelineStageError(context, mapped.stage ?? ''))
  }

  if (problems.length > 0 || companyId === null || stageId === undefined) {
    return error(...problems)
  }

  return {
    object: 'raises',
    draft: raiseFieldsDraft(mapped, customFields),
    companyId,
    stageId,
    ownerId: people.ownerId,
    personIds: people.personIds,
    setsPeople: people.setsPeople,
  }
}

function planCustomFieldDefinition(
  _context: PlanContext,
  mapped: Readonly<Record<string, string>>,
): ImportWrite {
  return { object: 'custom_fields', draft: customFieldDefinitionDraft(mapped) }
}

function isRowPlan(value: ImportWrite | RowPlan): value is RowPlan {
  return 'action' in value
}

/** Resolves every reference the row names into the write it would perform. */
function resolveWrite(context: PlanContext, mapped: Readonly<Record<string, string>>): ImportWrite | RowPlan {
  const customFields = customFieldsForRow(context, mapped)

  switch (context.object) {
    case 'companies':
      return { object: 'companies', draft: companyDraft(mapped, customFields) }
    case 'people': {
      const write: {
        object: 'people'
        draft: PersonDraft
        consent?: ImportConsentGrant
      } = { object: 'people', draft: personDraft(mapped, customFields) }
      const consent = readConsentGrant(context, mapped)
      if (consent !== undefined) {
        write.consent = consent
      }
      return write
    }
    case 'positions':
      return planPosition(context, mapped)
    case 'deals':
      return planDeal(context, mapped)
    case 'opportunities':
      return planOpportunity(context, mapped)
    case 'enquiries':
      return planEnquiry(context, mapped)
    case 'partnerships':
      return planPartnership(context, mapped)
    case 'raises':
      return planRaise(context, mapped)
    case 'custom_fields':
      return planCustomFieldDefinition(context, mapped)
  }
}

/**
 * The consent grant a People row carries. Absent unless the job has a purpose
 * set on it AND the row has a non-blank `consent_status`. `validateRow` has
 * already refused an unknown status by the time this runs, so the coercion
 * below is safe.
 */
function readConsentGrant(
  context: PlanContext,
  mapped: Readonly<Record<string, string>>,
): ImportConsentGrant | undefined {
  if (context.consentPurposeId === null) return undefined
  const rawStatus = (mapped.consent_status ?? '').trim().toLowerCase()
  if (rawStatus.length === 0) return undefined
  if (rawStatus !== 'granted' && rawStatus !== 'withdrawn') return undefined
  const rawAt = (mapped.consent_at ?? '').trim()
  return {
    purposeId: context.consentPurposeId,
    status: rawStatus as ConsentStatus,
    notedAt: rawAt.length === 0 ? null : rawAt,
  }
}

/**
 * The company affiliation a People row asks for, if any, and any note about it.
 *
 * A row states an affiliation only when it carries both a title and a company
 * identity, so a blank optional cell still says nothing, the additive rule every
 * column follows. The company is matched by domain when the row has one and by
 * name otherwise. A named company that is not here follows `on_missing_company`:
 * `create` invents it from the row, `skip` imports the person alone and returns
 * a warning.
 */
function planAffiliation(
  context: PlanContext,
  mapped: Readonly<Record<string, string>>,
): { readonly affiliation?: PlannedAffiliation; readonly warnings: readonly StoredRowError[] } {
  const title = (mapped.title ?? '').trim()
  const domainRaw = (mapped.company_domain ?? '').trim()
  const nameRaw = (mapped.company_name ?? '').trim()

  if (title.length === 0 || (domainRaw.length === 0 && nameRaw.length === 0)) {
    return { warnings: [] }
  }

  const domain = normaliseDomain(domainRaw)
  const companyId =
    domainRaw.length > 0
      ? domain === null
        ? undefined
        : context.lookups.companyIdByDomain.get(domain)
      : context.lookups.companyIdByName.get(nameRaw.toLowerCase())

  if (companyId !== undefined) {
    return { affiliation: { kind: 'link', companyId, title }, warnings: [] }
  }

  if (context.onMissingCompany === 'create') {
    return {
      affiliation: { kind: 'create', company: affiliationCompanyDraft(mapped), title },
      warnings: [],
    }
  }

  const named = domainRaw.length > 0 ? domainRaw : nameRaw

  return {
    warnings: [
      {
        field: domainRaw.length > 0 ? 'company_domain' : 'company_name',
        message: `No company here matches "${named}", so the person imported without a position`,
      },
    ],
  }
}

/**
 * Folds a People row's affiliation into its create or update plan.
 *
 * A no-op for every other object, and for a person the row said nothing about a
 * company for. The affiliation rides on the write; any note rides on the plan.
 */
function withAffiliation(
  context: PlanContext,
  mapped: Readonly<Record<string, string>>,
  plan: Extract<RowPlan, { action: 'create' } | { action: 'update' }>,
): RowPlan {
  if (context.object !== 'people' || plan.write.object !== 'people') {
    return plan
  }

  const { affiliation, warnings } = planAffiliation(context, mapped)
  const write = affiliation === undefined ? plan.write : { ...plan.write, affiliation }

  return { ...plan, write, ...(warnings.length > 0 ? { warnings } : {}) }
}

/**
 * @param mapped The row's cells by Kelpie column, from `mapRow`.
 * @returns What this row would do. `create` when its key matches nothing;
 *   otherwise the job's conflict mode decides between `skip` and `update`.
 */
export function planRow(context: PlanContext, mapped: Readonly<Record<string, string>>): RowPlan {
  const invalid = validateRow(context.object, context.matchKey, mapped, {
    baseColumnKeys: context.baseColumnKeys,
    customFieldDefinitions: context.customFieldDefinitions,
  })

  if (invalid.length > 0) {
    return error(...invalid)
  }

  const write = resolveWrite(context, mapped)

  if (isRowPlan(write)) {
    return write
  }

  const key = buildMatchKey(context.matchKey, mapped)

  // Unreachable while every match-key column is required, which `validateRow`
  // enforces. Kept because that coupling lives in another file.
  if (key === null) {
    return error({
      field: context.matchKey.columns[0] ?? 'match_key',
      message: 'The key columns are not all filled in, so this row cannot be matched',
    })
  }

  const targetId = context.lookups.existing.get(key)

  if (targetId === undefined) {
    return withAffiliation(context, mapped, { action: 'create', key, write })
  }

  // An empty string is the placeholder an in-file match carries: the record it
  // matched has not been written yet, so there is no id to report.
  const resolved = targetId.length === 0 ? null : targetId

  // A skipped row is left entirely alone, affiliation included. A caller who
  // wants an existing person's position updated runs the job in `update` mode,
  // which is where the rename-in-place lives.
  return context.conflictMode === 'update'
    ? withAffiliation(context, mapped, { action: 'update', key, targetId: resolved, write })
    : { action: 'skip', key, targetId: resolved }
}

/**
 * Plans a whole file.
 *
 * A row that would create a record registers its key, so a later row carrying
 * the same key reads as a match rather than as a second create. That is the
 * in-file duplicate the mockup handles too, and without it a file listing one
 * company twice reports two creates and performs one.
 */
export function planRows(context: PlanContext, rows: readonly MappedRow[]): readonly PlannedRow[] {
  const existing = new Map(context.lookups.existing)
  const withOverlay: PlanContext = { ...context, lookups: { ...context.lookups, existing } }

  return rows.map((row) => {
    const plan = planRow(withOverlay, row.mapped)

    if (plan.action === 'create') {
      existing.set(plan.key, '')
    }

    return { row: row.row, plan }
  })
}

export function countPlans(rows: readonly PlannedRow[]): ImportCounts {
  const counts = { total: rows.length, create: 0, update: 0, skip: 0, error: 0 }

  for (const { plan } of rows) {
    counts[plan.action] += 1
  }

  return counts
}
