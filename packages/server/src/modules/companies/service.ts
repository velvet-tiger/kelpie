import type { CustomFieldWireValue } from '@kelpie/schemas'

import { changedKeys } from '../../lib/changes.ts'
import { UNIQUE_VIOLATION, isReferenceViolation, postgresErrorCode } from '../../lib/database.ts'
import type { Database } from '../../lib/database.ts'
import { autoLinkCompanyByDomain } from '../../lib/emailDomainAutoLink.ts'
import { AppError } from '../../lib/errors.ts'
import type { IdFactory } from '../../lib/ids.ts'
import { normaliseDomain } from '../../lib/normalisation.ts'
import { mapPage, readListWindow, toPage } from '../../lib/pagination.ts'
import type { ListQueryParameters, Page } from '../../lib/pagination.ts'
import type { TransactionScope } from '../../runtime/transaction.ts'
import type { ActivityRecorder } from '../activities/recorder.ts'
import { describeCreation, describeUpdate } from '../activities/wording.ts'
import type { FieldLabels } from '../activities/wording.ts'
import { toEventActor } from '../../lib/actor.ts'
import type { Actor } from '../auth/actor.ts'
import { requireWorkspaceId } from '../auth/actor.ts'
import './events.ts'
import { deleteRecordsAttachedTo } from '../attachedRecords.ts'
import type { CustomFieldValuesValidator } from '../custom-fields/values.ts'
import { referencedElsewhere } from '../references.ts'
import * as repository from './repository.ts'
import { COMPANY_SORTS, DEFAULT_COMPANY_SORT } from './repository.ts'
import type { CompanyFilters, CompanyRecord } from './repository.ts'
import type { AccountType, CompanyStage, IcpFit, SizeBand } from './schema.ts'

/**
 * Companies: the organisations behind the people.
 *
 * People attach through Position, never through a company id on Person, so
 * nothing here knows about a person except through that link.
 */

export interface CompaniesDependencies {
  readonly db: Database
  readonly transaction: TransactionScope
  readonly createId: IdFactory
  readonly now: () => Date
  readonly recordActivity: ActivityRecorder
  readonly customFields: CustomFieldValuesValidator
}

/** What a changed column is called on a timeline. `icpFit` is why these are written out. */
const COMPANY_FIELD_LABELS: FieldLabels = {
  name: 'Name',
  domain: 'Domain',
  industry: 'Industry',
  description: 'Description',
  stage: 'Stage',
  sizeBand: 'Size',
  hq: 'Headquarters',
  website: 'Website',
  accountType: 'Account type',
  icpFit: 'ICP fit',
  techStack: 'Tech stack',
  summary: 'Summary',
  tags: 'Tags',
  isOwn: 'Own company',
}

/** A company as the API returns one: the stored row minus the tenancy column. */
export type CompanyView = Omit<CompanyRecord, 'workspaceId'>

export interface CreateCompanyInput {
  readonly name: string
  readonly domain: string | null
  readonly industry: string | null
  readonly description: string
  readonly stage: CompanyStage
  readonly sizeBand: SizeBand
  readonly hq: string | null
  readonly website: string | null
  readonly accountType: AccountType
  readonly icpFit: IcpFit
  readonly techStack: readonly string[]
  readonly summary: string
  readonly tags: readonly string[]
  readonly isOwn: boolean
  /** Wire shape merge patch (undefined for a create without any). */
  readonly customFields: Readonly<Record<string, CustomFieldWireValue | null>> | undefined
}

/** PATCH semantics: an absent field is left alone, and null clears a nullable one. */
export type UpdateCompanyInput = Partial<CreateCompanyInput>

export interface CompaniesService {
  list(actor: Actor, filters: CompanyFilters, query: ListQueryParameters): Promise<Page<CompanyView>>
  get(actor: Actor, id: string): Promise<CompanyView>
  create(actor: Actor, input: CreateCompanyInput): Promise<CompanyView>
  update(actor: Actor, id: string, changes: UpdateCompanyInput): Promise<CompanyView>
  remove(actor: Actor, id: string): Promise<void>
}

function toView(record: CompanyRecord): CompanyView {
  const { workspaceId: _workspaceId, ...view } = record

  return view
}

/**
 * The stored form of what the caller sent. A domain arrives however someone
 * pasted it and is reduced to a host; blank becomes null, because the domain is
 * unique per workspace and a stored `''` would make the second company without a
 * website a 409.
 */
function toStoredColumns(input: UpdateCompanyInput): Partial<repository.CompanyColumns> {
  return {
    ...(input.name === undefined ? {} : { name: input.name }),
    ...(input.domain === undefined
      ? {}
      : { domain: input.domain === null ? null : normaliseDomain(input.domain) }),
    ...(input.industry === undefined ? {} : { industry: input.industry }),
    ...(input.description === undefined ? {} : { description: input.description }),
    ...(input.stage === undefined ? {} : { stage: input.stage }),
    ...(input.sizeBand === undefined ? {} : { sizeBand: input.sizeBand }),
    ...(input.hq === undefined ? {} : { hq: input.hq }),
    ...(input.website === undefined ? {} : { website: input.website }),
    ...(input.accountType === undefined ? {} : { accountType: input.accountType }),
    ...(input.icpFit === undefined ? {} : { icpFit: input.icpFit }),
    ...(input.techStack === undefined ? {} : { techStack: [...input.techStack] }),
    ...(input.summary === undefined ? {} : { summary: input.summary }),
    ...(input.tags === undefined ? {} : { tags: [...input.tags] }),
    ...(input.isOwn === undefined ? {} : { isOwn: input.isOwn }),
  }
}

function duplicateDomain(): AppError {
  return AppError.conflict('Another company in this workspace already has that domain', [
    { field: 'domain', message: 'Already in use' },
  ])
}

export function createCompaniesService(dependencies: CompaniesDependencies): CompaniesService {
  async function require(workspaceId: string, id: string): Promise<CompanyRecord> {
    const company = await repository.findCompany(dependencies.db, workspaceId, id)

    // A company in another workspace is indistinguishable from one that never
    // existed, per `api.md`.
    if (company === undefined) {
      throw AppError.notFound('Company not found')
    }

    return company
  }

  return {
    async list(actor, filters, query) {
      const workspaceId = requireWorkspaceId(actor)
      const window = readListWindow(query, COMPANY_SORTS, DEFAULT_COMPANY_SORT)
      const rows = await repository.listCompanies(dependencies.db, workspaceId, filters, window)

      return mapPage(toPage(rows, window, (company) => company.id), toView)
    },

    async get(actor, id) {
      return toView(await require(requireWorkspaceId(actor), id))
    },

    async create(actor, input) {
      const workspaceId = requireWorkspaceId(actor)
      const id = dependencies.createId('company')

      return dependencies.transaction(async ({ tx, events }) => {
        const customFields = await dependencies.customFields.forCreate(
          tx,
          workspaceId,
          'company',
          input.customFields,
        )
        let created: CompanyRecord

        try {
          created = await repository.insertCompany(tx, {
            id,
            workspaceId,
            name: input.name,
            domain: input.domain === null ? null : normaliseDomain(input.domain),
            industry: input.industry,
            description: input.description,
            stage: input.stage,
            sizeBand: input.sizeBand,
            hq: input.hq,
            website: input.website,
            accountType: input.accountType,
            icpFit: input.icpFit,
            techStack: [...input.techStack],
            summary: input.summary,
            tags: [...input.tags],
            isOwn: input.isOwn,
            customFields,
          })
        } catch (error: unknown) {
          if (postgresErrorCode(error) === UNIQUE_VIOLATION) {
            throw duplicateDomain()
          }

          throw error
        }

        await dependencies.recordActivity(tx, workspaceId, actor, {
          targetType: 'company',
          targetId: created.id,
          kind: 'created',
          ...describeCreation('Company'),
        })

        events.emit('companies.company.created', { type: 'company', id: created.id }, {})

        // Sync sweep of the workspace's people: everyone whose email domain
        // matches this Company gets a titleless Position where none exists yet.
        // Inside the same transaction so a follow-up read sees the new links.
        await autoLinkCompanyByDomain(tx, events, workspaceId, created, {
          createId: dependencies.createId,
          now: dependencies.now,
          recordActivity: dependencies.recordActivity,
        })

        return toView(created)
      }, { workspaceId, actor: toEventActor(actor) })
    },

    async update(actor, id, changes) {
      const workspaceId = requireWorkspaceId(actor)
      const existing = await require(workspaceId, id)
      const columns = toStoredColumns(changes)
      const scalarChanged = changedKeys(existing, columns)

      return dependencies.transaction(async ({ tx, events }) => {
        const cf = await dependencies.customFields.forUpdate(
          tx,
          workspaceId,
          'company',
          existing.customFields,
          changes.customFields,
        )
        const customFieldsChanged = cf !== undefined && cf.changedPaths.length > 0

        if (scalarChanged.length === 0 && !customFieldsChanged) {
          return toView(existing)
        }

        let updated: CompanyRecord | undefined

        try {
          updated = await repository.updateCompany(tx, workspaceId, id, {
            ...columns,
            ...(customFieldsChanged ? { customFields: cf.merged } : {}),
            updatedAt: dependencies.now(),
          })
        } catch (error: unknown) {
          if (postgresErrorCode(error) === UNIQUE_VIOLATION) {
            throw duplicateDomain()
          }

          throw error
        }

        if (updated === undefined) {
          throw AppError.notFound('Company not found')
        }

        const customFieldPaths = cf?.changedPaths ?? []
        const activityChanged = [...scalarChanged, ...customFieldPaths]

        if (activityChanged.length > 0) {
          const labels: Record<string, string> = { ...COMPANY_FIELD_LABELS, ...cf?.labels }
          const before: Record<string, unknown> = { ...existing, ...cf?.flatBefore }
          const after: Record<string, unknown> = { ...columns, ...cf?.flatAfter }
          await dependencies.recordActivity(tx, workspaceId, actor, {
            targetType: 'company',
            targetId: id,
            kind: 'updated',
            ...describeUpdate(activityChanged, labels, before, after),
          })
        }

        events.emit(
          'companies.company.updated',
          { type: 'company', id },
          { changed: [...scalarChanged, ...customFieldPaths] },
        )

        // Sync sweep when the domain moved. A newly-set domain gains matches;
        // a changed domain gains new matches without touching the old links
        // (never-remove — a person may still work at the previous domain).
        if (scalarChanged.includes('domain')) {
          await autoLinkCompanyByDomain(tx, events, workspaceId, updated, {
            createId: dependencies.createId,
            now: dependencies.now,
            recordActivity: dependencies.recordActivity,
          })
        }

        return toView(updated)
      }, { workspaceId, actor: toEventActor(actor) })
    },

    async remove(actor, id) {
      const workspaceId = requireWorkspaceId(actor)

      await dependencies.transaction(async ({ tx, events }) => {
        await require(workspaceId, id)

        // Positions die with the company through their foreign key. Notes,
        // activities and decisions have none, so they are removed here, in the
        // same transaction as the delete that may still be refused.
        await deleteRecordsAttachedTo(tx, workspaceId, 'company', id)

        try {
          await repository.deleteCompany(tx, workspaceId, id)
        } catch (error: unknown) {
          if (isReferenceViolation(error)) {
            throw referencedElsewhere(error, 'company')
          }

          throw error
        }

        events.emit('companies.company.deleted', { type: 'company', id }, {})
      }, { workspaceId, actor: toEventActor(actor) })
    },
  }
}
