import type {
  ImportConflictMode,
  ImportCounts,
  ImportObject,
  MatchKeyOption,
  OnMissingCompany,
} from '@kelpie/schemas'

import { normaliseDomain, normaliseEmail } from '../../lib/normalisation.ts'
import { affiliationCompanyDraft, companyDraft, dealFieldsDraft, personDraft } from './drafts.ts'
import type { CompanyDraft, DealFieldsDraft, PersonDraft } from './drafts.ts'
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
  /** Deal stage id, keyed by both its slug and its folded label. */
  readonly dealStageIdByName: ReadonlyMap<string, string>
}

export interface PlanContext {
  readonly object: ImportObject
  readonly matchKey: MatchKeyOption
  readonly conflictMode: ImportConflictMode
  /** What a People row does with an absent company. Ignored by the other objects. */
  readonly onMissingCompany: OnMissingCompany
  readonly lookups: ImportLookups
}

/**
 * A company affiliation a People row asks for: the position to write, and
 * whether the company must be created before it can be linked.
 */
export type PlannedAffiliation =
  | { readonly kind: 'link'; readonly companyId: string; readonly title: string }
  | { readonly kind: 'create'; readonly company: CompanyDraft; readonly title: string }

/** The values a write applies, once every reference in the row has been resolved. */
export type ImportWrite =
  | { readonly object: 'companies'; readonly draft: CompanyDraft }
  | {
      readonly object: 'people'
      readonly draft: PersonDraft
      /** A position to upsert alongside the person, when the row named a company and a title. */
      readonly affiliation?: PlannedAffiliation
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
      /**
       * Whether the row said anything about the deal's contacts.
       *
       * An empty `personIds` means two different things — the column was not
       * mapped, or it was mapped and left blank — and only a filled-in cell is
       * the file stating the list. Without this an update would clear the
       * contacts of every deal in a file that never carried the column.
       */
      readonly setsPeople: boolean
    }

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

/**
 * The stage a deal row names, as a stage of this workspace.
 *
 * Its own slug first, then its label, then the vendor alias table. Slug before
 * label because a rename leaves the slug alone, which is the whole reason an
 * import addresses stages by slug (`pipeline_stages` in `schema.md`).
 */
function resolveStageId(lookups: ImportLookups, raw: string): string | undefined {
  const folded = raw.trim().toLowerCase()
  const direct = lookups.dealStageIdByName.get(folded)

  if (direct !== undefined) {
    return direct
  }

  const aliased = aliasedStageSlug(raw)

  return aliased === undefined ? undefined : lookups.dealStageIdByName.get(aliased)
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

/**
 * A deal's company, stage, owner and contacts.
 *
 * A missing company fails the row rather than creating a stub, per
 * `import-export.md`. An `owner_email` that names nobody in the workspace also
 * fails it: the mockup silently resolves that to the importer, and quietly
 * moving another person's deals onto whoever ran the import is worse data than a
 * refused row. Unmapping the column is the way to import without owners.
 */
function planDeal(context: PlanContext, mapped: Readonly<Record<string, string>>): ImportWrite | RowPlan {
  const problems: StoredRowError[] = []
  const domain = normaliseDomain(mapped.company_domain ?? '')
  const companyId = domain === null ? undefined : context.lookups.companyIdByDomain.get(domain)

  if (companyId === undefined) {
    problems.push({
      field: 'company_domain',
      message: 'No company here has that domain. Import companies first',
    })
  }

  const stageId = resolveStageId(context.lookups, mapped.stage ?? '')

  if (stageId === undefined) {
    problems.push({
      field: 'stage',
      message: `"${(mapped.stage ?? '').trim()}" is not a stage of this workspace's deal pipeline`,
    })
  }

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

  if (problems.length > 0 || companyId === undefined || stageId === undefined) {
    return error(...problems)
  }

  return {
    object: 'deals',
    draft: dealFieldsDraft(mapped),
    companyId,
    stageId,
    ownerId,
    personIds: [...new Set(personIds)],
    setsPeople: (mapped.person_emails ?? '').trim().length > 0,
  }
}

function isRowPlan(value: ImportWrite | RowPlan): value is RowPlan {
  return 'action' in value
}

/** Resolves every reference the row names into the write it would perform. */
function resolveWrite(context: PlanContext, mapped: Readonly<Record<string, string>>): ImportWrite | RowPlan {
  switch (context.object) {
    case 'companies':
      return { object: 'companies', draft: companyDraft(mapped) }
    case 'people':
      return { object: 'people', draft: personDraft(mapped) }
    case 'positions':
      return planPosition(context, mapped)
    case 'deals':
      return planDeal(context, mapped)
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
  const invalid = validateRow(context.object, context.matchKey, mapped)

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
