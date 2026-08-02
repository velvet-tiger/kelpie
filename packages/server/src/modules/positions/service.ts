import { UNIQUE_VIOLATION, postgresErrorCode } from '../../lib/database.ts'
import type { Database } from '../../lib/database.ts'
import { AppError } from '../../lib/errors.ts'
import type { IdFactory } from '../../lib/ids.ts'
import { mapPage, readListWindow, toPage } from '../../lib/pagination.ts'
import type { ListQueryParameters, Page } from '../../lib/pagination.ts'
import type { TransactionScope } from '../../runtime/transaction.ts'
import type { Actor } from '../auth/actor.ts'
import { requireWorkspaceId } from '../auth/actor.ts'
import * as companyRepository from '../companies/repository.ts'
import * as personRepository from '../people/repository.ts'
import * as repository from './repository.ts'
import { DEFAULT_POSITION_SORT, POSITION_SORTS } from './repository.ts'
import type { PositionFilters, PositionRecord } from './repository.ts'

/**
 * Position: the person-to-company link, and the only place a job title lives.
 *
 * A bare company id on Person would force one title per person, which is wrong
 * for advisors, founders, and anyone mid-move.
 *
 * A pure dependent. It dies with either side through its foreign keys, and
 * nothing restricts on it, so deleting one is always allowed.
 */

export interface PositionsDependencies {
  readonly db: Database
  readonly transaction: TransactionScope
  readonly createId: IdFactory
  readonly now: () => Date
}

/** A position as the API returns one: the stored row minus the tenancy column. */
export type PositionView = Omit<PositionRecord, 'workspaceId'>

export interface CreatePositionInput {
  readonly personId: string
  readonly companyId: string
  readonly title: string
}

/** Only the title can move. Repointing a link at a different person is a delete and a create. */
export interface UpdatePositionInput {
  readonly title?: string | undefined
}

export interface PositionsService {
  list(
    actor: Actor,
    filters: PositionFilters,
    query: ListQueryParameters,
  ): Promise<Page<PositionView>>
  get(actor: Actor, id: string): Promise<PositionView>
  create(actor: Actor, input: CreatePositionInput): Promise<PositionView>
  update(actor: Actor, id: string, changes: UpdatePositionInput): Promise<PositionView>
  remove(actor: Actor, id: string): Promise<void>
}

function toView(record: PositionRecord): PositionView {
  const { workspaceId: _workspaceId, ...view } = record

  return view
}

function duplicatePosition(): AppError {
  return AppError.conflict('That person already holds that title at that company', [
    { field: 'title', message: 'Already held at this company' },
  ])
}

export function createPositionsService(dependencies: PositionsDependencies): PositionsService {
  async function require(workspaceId: string, id: string): Promise<PositionRecord> {
    const position = await repository.findPosition(dependencies.db, workspaceId, id)

    if (position === undefined) {
      throw AppError.notFound('Position not found')
    }

    return position
  }

  /**
   * Both ends must be in the caller's workspace.
   *
   * The foreign keys alone would let a request link to a record in another
   * workspace, because they are global. Checking here is what makes the tenancy
   * boundary hold, and a record on the far side of it reports as missing rather
   * than as forbidden, per `api.md`.
   */
  async function requireEnds(workspaceId: string, input: CreatePositionInput): Promise<void> {
    const person = await personRepository.findPerson(dependencies.db, workspaceId, input.personId)

    if (person === undefined) {
      throw AppError.notFound('Person not found')
    }

    const company = await companyRepository.findCompany(
      dependencies.db,
      workspaceId,
      input.companyId,
    )

    if (company === undefined) {
      throw AppError.notFound('Company not found')
    }
  }

  return {
    async list(actor, filters, query) {
      const workspaceId = requireWorkspaceId(actor)
      const window = readListWindow(query, POSITION_SORTS, DEFAULT_POSITION_SORT)
      const rows = await repository.listPositions(dependencies.db, workspaceId, filters, window)

      return mapPage(toPage(rows, window, (position) => position.id), toView)
    },

    async get(actor, id) {
      return toView(await require(requireWorkspaceId(actor), id))
    },

    async create(actor, input) {
      const workspaceId = requireWorkspaceId(actor)

      await requireEnds(workspaceId, input)

      const id = dependencies.createId('position')

      return dependencies.transaction(async ({ tx, events }) => {
        let created: PositionRecord

        try {
          created = await repository.insertPosition(tx, {
            id,
            workspaceId,
            personId: input.personId,
            companyId: input.companyId,
            title: input.title,
          })
        } catch (error: unknown) {
          if (postgresErrorCode(error) === UNIQUE_VIOLATION) {
            throw duplicatePosition()
          }

          throw error
        }

        events.emit('record.created', { workspaceId, objectType: 'position', recordId: created.id })

        return toView(created)
      })
    },

    async update(actor, id, changes) {
      const workspaceId = requireWorkspaceId(actor)
      const existing = await require(workspaceId, id)

      if (changes.title === undefined || changes.title === existing.title) {
        return toView(existing)
      }

      const title = changes.title

      return dependencies.transaction(async ({ tx, events }) => {
        let updated: PositionRecord | undefined

        try {
          updated = await repository.updatePosition(tx, workspaceId, id, {
            title,
            updatedAt: dependencies.now(),
          })
        } catch (error: unknown) {
          if (postgresErrorCode(error) === UNIQUE_VIOLATION) {
            throw duplicatePosition()
          }

          throw error
        }

        if (updated === undefined) {
          throw AppError.notFound('Position not found')
        }

        events.emit('record.updated', {
          workspaceId,
          objectType: 'position',
          recordId: id,
          changedFields: ['title'],
        })

        return toView(updated)
      })
    },

    async remove(actor, id) {
      const workspaceId = requireWorkspaceId(actor)

      await dependencies.transaction(async ({ tx, events }) => {
        await require(workspaceId, id)
        await repository.deletePosition(tx, workspaceId, id)

        events.emit('record.deleted', { workspaceId, objectType: 'position', recordId: id })
      })
    },
  }
}
