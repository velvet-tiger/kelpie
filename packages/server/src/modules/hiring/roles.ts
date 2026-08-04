import type { RoleStatus } from '@kelpie/schemas'

import { changedKeys } from '../../lib/changes.ts'
import type { Database } from '../../lib/database.ts'
import { AppError } from '../../lib/errors.ts'
import type { IdFactory } from '../../lib/ids.ts'
import { mapPage, readListWindow, toPage } from '../../lib/pagination.ts'
import type { ListQueryParameters, Page } from '../../lib/pagination.ts'
import type { TransactionScope } from '../../runtime/transaction.ts'
import type { ActivityRecorder } from '../activities/recorder.ts'
import { describeUnlink } from '../activities/wording.ts'
import type { Actor } from '../auth/actor.ts'
import { requireWorkspaceId } from '../auth/actor.ts'
import { deleteRecordsAttachedTo } from '../attachedRecords.ts'
import * as repository from './repository.ts'
import { DEFAULT_ROLE_SORT, ROLE_SORTS } from './repository.ts'
import type { RoleFilters, RoleRecord } from './repository.ts'

/**
 * Role: an opening the workspace is hiring for.
 *
 * A Role holds no people and has no timeline of its own — it is not one of the
 * `RECORD_TARGET_TYPES` a note, activity, or decision attaches to. The people
 * are Candidates, and what happens to them is news on their own pages.
 */

export interface RolesDependencies {
  readonly db: Database
  readonly transaction: TransactionScope
  readonly createId: IdFactory
  readonly now: () => Date
  readonly recordActivity: ActivityRecorder
}

/** A role as the API returns one: the stored row minus the tenancy column. */
export type RoleView = Omit<RoleRecord, 'workspaceId'>

export interface CreateRoleInput {
  readonly title: string
  /** Absent means open: a role is created because it is being hired for. */
  readonly status: RoleStatus
}

export interface UpdateRoleInput {
  readonly title?: string | undefined
  readonly status?: RoleStatus | undefined
}

export interface RolesService {
  list(actor: Actor, filters: RoleFilters, query: ListQueryParameters): Promise<Page<RoleView>>
  get(actor: Actor, id: string): Promise<RoleView>
  create(actor: Actor, input: CreateRoleInput): Promise<RoleView>
  update(actor: Actor, id: string, changes: UpdateRoleInput): Promise<RoleView>
  remove(actor: Actor, id: string): Promise<void>
}

function toView(record: RoleRecord): RoleView {
  const { workspaceId: _workspaceId, ...view } = record

  return view
}

function toStoredColumns(input: UpdateRoleInput): Partial<repository.RoleColumns> {
  return {
    ...(input.title === undefined ? {} : { title: input.title }),
    ...(input.status === undefined ? {} : { status: input.status }),
  }
}

export function createRolesService(dependencies: RolesDependencies): RolesService {
  async function require(workspaceId: string, id: string): Promise<RoleRecord> {
    const role = await repository.findRole(dependencies.db, workspaceId, id)

    if (role === undefined) {
      throw AppError.notFound('Role not found')
    }

    return role
  }

  return {
    async list(actor, filters, query) {
      const workspaceId = requireWorkspaceId(actor)
      const window = readListWindow(query, ROLE_SORTS, DEFAULT_ROLE_SORT)
      const rows = await repository.listRoles(dependencies.db, workspaceId, filters, window)

      return mapPage(toPage(rows, window, (role) => role.id), toView)
    },

    async get(actor, id) {
      return toView(await require(requireWorkspaceId(actor), id))
    },

    async create(actor, input) {
      const workspaceId = requireWorkspaceId(actor)
      const id = dependencies.createId('role')

      return dependencies.transaction(async ({ tx, events }) => {
        const created = await repository.insertRole(tx, {
          id,
          workspaceId,
          title: input.title,
          status: input.status,
        })

        events.emit('record.created', { workspaceId, objectType: 'role', recordId: id })

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
        const updated = await repository.updateRole(tx, workspaceId, id, {
          ...columns,
          updatedAt: dependencies.now(),
        })

        if (updated === undefined) {
          throw AppError.notFound('Role not found')
        }

        events.emit('record.updated', {
          workspaceId,
          objectType: 'role',
          recordId: id,
          changedFields: changed,
        })

        return toView(updated)
      })
    },

    /**
     * Deletes the role and, by cascade, every candidacy on it.
     *
     * The candidacies go through their foreign key without a service seeing
     * them, so their interview notes are removed here first. Each affected
     * person gets the unlink on their timeline, because a candidacy vanishing
     * is news on the page that showed it and the role's own page is gone.
     */
    async remove(actor, id) {
      const workspaceId = requireWorkspaceId(actor)

      await dependencies.transaction(async ({ tx, events }) => {
        const role = await require(workspaceId, id)
        const held = await repository.listCandidatesOfRole(tx, workspaceId, id)

        for (const candidacy of held) {
          await deleteRecordsAttachedTo(tx, workspaceId, 'candidate', candidacy.id)
          await dependencies.recordActivity(tx, workspaceId, actor, {
            targetType: 'person',
            targetId: candidacy.personId,
            kind: 'unlinked',
            ...describeUnlink('role', role.title),
          })
        }

        await repository.deleteRole(tx, workspaceId, id)

        events.emit('record.deleted', { workspaceId, objectType: 'role', recordId: id })
      })
    },
  }
}
