import { changedKeys } from '../../lib/changes.ts'
import { UNIQUE_VIOLATION, isReferenceViolation, postgresErrorCode } from '../../lib/database.ts'
import type { Database } from '../../lib/database.ts'
import { AppError } from '../../lib/errors.ts'
import type { IdFactory } from '../../lib/ids.ts'
import { normaliseDomain } from '../../lib/normalisation.ts'
import { mapPage, readListWindow, toPage } from '../../lib/pagination.ts'
import type { ListQueryParameters, Page } from '../../lib/pagination.ts'
import type { TransactionScope } from '../../runtime/transaction.ts'
import type { Actor } from '../auth/actor.ts'
import { requireWorkspaceId } from '../auth/actor.ts'
import { deleteRecordsAttachedTo } from '../attachedRecords.ts'
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
          })
        } catch (error: unknown) {
          if (postgresErrorCode(error) === UNIQUE_VIOLATION) {
            throw duplicateDomain()
          }

          throw error
        }

        events.emit('record.created', { workspaceId, objectType: 'company', recordId: created.id })

        return toView(created)
      })
    },

    async update(actor, id, changes) {
      const workspaceId = requireWorkspaceId(actor)
      const existing = await require(workspaceId, id)
      const columns = toStoredColumns(changes)
      const changed = changedKeys(existing, columns)

      if (changed.length === 0) {
        return toView(existing)
      }

      return dependencies.transaction(async ({ tx, events }) => {
        let updated: CompanyRecord | undefined

        try {
          updated = await repository.updateCompany(tx, workspaceId, id, {
            ...columns,
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

        events.emit('record.updated', {
          workspaceId,
          objectType: 'company',
          recordId: id,
          changedFields: changed,
        })

        return toView(updated)
      })
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

        events.emit('record.deleted', { workspaceId, objectType: 'company', recordId: id })
      })
    },
  }
}
