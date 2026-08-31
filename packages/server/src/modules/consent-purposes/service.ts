import { CONSENT_PURPOSE_STATUSES } from '@kelpie/schemas'
import type { ConsentPurposeStatus } from '@kelpie/schemas'
import { and, eq, sql } from 'drizzle-orm'

import { toEventActor } from '../../lib/actor.ts'
import { changedKeys } from '../../lib/changes.ts'
import {
  FOREIGN_KEY_VIOLATION,
  UNIQUE_VIOLATION,
  postgresErrorCode,
} from '../../lib/database.ts'
import type { Database } from '../../lib/database.ts'
import { AppError } from '../../lib/errors.ts'
import type { IdFactory } from '../../lib/ids.ts'
import { mapPage, readListWindow, toPage } from '../../lib/pagination.ts'
import type { ListQueryParameters, Page } from '../../lib/pagination.ts'
import type { EntitlementRegistry } from '../../runtime/entitlements.ts'
import { limitFor } from '../../runtime/entitlements.ts'
import type { Transaction, TransactionScope } from '../../runtime/transaction.ts'
import type { Actor } from '../auth/actor.ts'
import { requireWorkspaceId } from '../auth/actor.ts'
import { formFields } from '../forms/schema.ts'
import { roleAllows } from '../workspace/roles.ts'
import { CONSENT_PURPOSES_LIMIT } from './capabilities.ts'
import './events.ts'
import * as repository from './repository.ts'
import {
  CONSENT_PURPOSE_SORTS,
  DEFAULT_CONSENT_PURPOSE_SORT,
} from './repository.ts'
import type {
  ConsentPurposeFilters,
  ConsentPurposeRecord,
} from './repository.ts'

/**
 * CRUD for the workspace's consent purposes.
 *
 * Reads are open to any workspace member — every capture site needs to list
 * them to render its purpose picker. Writes need the admin role: a purpose
 * change touches every form and import job that names it, and it is
 * team-wide config rather than a per-user preference.
 */

/** Hard cap per workspace. Bites when the entitlement leaves the count unlimited. */
export const CONSENT_PURPOSES_HARD_CAP = 50

const KEY_PATTERN = /^[a-z][a-z0-9_]*$/u
const MAX_SLUG_LENGTH = 64
const MAX_LABEL_LENGTH = 120
const MIN_LABEL_LENGTH = 1
const MAX_DESCRIPTION_LENGTH = 2000

export interface ConsentPurposesDependencies {
  readonly db: Database
  readonly transaction: TransactionScope
  readonly createId: IdFactory
  readonly now: () => Date
  readonly entitlements: EntitlementRegistry
}

/** What the API returns: the stored row minus the tenancy column. */
export type ConsentPurposeView = Omit<ConsentPurposeRecord, 'workspaceId'>

export interface CreateConsentPurposeInput {
  readonly slug: string
  readonly label: string
  readonly description: string
  readonly defaultStatus: ConsentPurposeStatus
}

/** PATCH semantics: `slug` is immutable and refused by the route body. */
export interface UpdateConsentPurposeInput {
  readonly label?: string | undefined
  readonly description?: string | undefined
  readonly defaultStatus?: ConsentPurposeStatus | undefined
  readonly sortOrder?: number | undefined
}

export interface ConsentPurposesService {
  list(
    actor: Actor,
    filters: ConsentPurposeFilters,
    query: ListQueryParameters,
  ): Promise<Page<ConsentPurposeView>>
  get(actor: Actor, id: string): Promise<ConsentPurposeView>
  create(actor: Actor, input: CreateConsentPurposeInput): Promise<ConsentPurposeView>
  update(
    actor: Actor,
    id: string,
    changes: UpdateConsentPurposeInput,
  ): Promise<ConsentPurposeView>
  remove(actor: Actor, id: string): Promise<void>
}

function toView(record: ConsentPurposeRecord): ConsentPurposeView {
  const { workspaceId: _workspaceId, ...view } = record
  return view
}

function fieldError(field: string, message: string): AppError {
  return AppError.validationFailed('That consent purpose is not valid', [{ field, message }])
}

function duplicateSlug(): AppError {
  return AppError.conflict('Another consent purpose already uses that slug', [
    { field: 'slug', message: 'Already in use' },
  ])
}

function validateSlug(slug: string): void {
  if (slug.length === 0 || slug.length > MAX_SLUG_LENGTH) {
    throw fieldError('slug', `1 to ${String(MAX_SLUG_LENGTH)} characters`)
  }
  if (!KEY_PATTERN.test(slug)) {
    throw fieldError(
      'slug',
      'Lowercase letters, digits and underscores; must start with a letter',
    )
  }
}

function validateLabel(label: string): void {
  if (label.length < MIN_LABEL_LENGTH || label.length > MAX_LABEL_LENGTH) {
    throw fieldError(
      'label',
      `${String(MIN_LABEL_LENGTH)} to ${String(MAX_LABEL_LENGTH)} characters`,
    )
  }
}

function validateDescription(description: string): void {
  if (description.length > MAX_DESCRIPTION_LENGTH) {
    throw fieldError('description', `At most ${String(MAX_DESCRIPTION_LENGTH)} characters`)
  }
}

function validateDefaultStatus(status: string): void {
  if (!CONSENT_PURPOSE_STATUSES.includes(status as ConsentPurposeStatus)) {
    throw fieldError('default_status', `Unknown status "${status}"`)
  }
}

/**
 * A purpose still named by a form's consent field cannot be deleted. Counted
 * here so the 409 names the referencing type; the FK on either side would
 * refuse the delete on its own but only name one.
 */
async function referencingTypes(
  db: Database | Transaction,
  workspaceId: string,
  id: string,
): Promise<readonly string[]> {
  const [fieldRow] = await Promise.all([
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(formFields)
      .where(
        and(
          eq(formFields.workspaceId, workspaceId),
          // The array contains this purpose id. A form field carries a set of
          // purposes; the delete is refused if any field still lists this one.
          sql`${id} = ANY(${formFields.consentPurposeIds})`,
        ),
      ),
  ])

  const referencing: string[] = []
  if (Number(fieldRow[0]?.count ?? 0) > 0) {
    referencing.push('form_field')
  }
  return referencing
}

export function createConsentPurposesService(
  dependencies: ConsentPurposesDependencies,
): ConsentPurposesService {
  function requireAdminWorkspace(actor: Actor): string {
    const workspaceId = requireWorkspaceId(actor)
    if (actor.role === null || !roleAllows(actor.role, 'admin')) {
      throw new AppError('forbidden', 'This action needs the admin role')
    }
    return workspaceId
  }

  async function require(
    workspaceId: string,
    id: string,
  ): Promise<ConsentPurposeRecord> {
    const purpose = await repository.findPurpose(dependencies.db, workspaceId, id)
    if (purpose === undefined) {
      throw AppError.notFound('Consent purpose not found')
    }
    return purpose
  }

  async function renumber(
    tx: Transaction,
    workspaceId: string,
    order: readonly ConsentPurposeRecord[],
  ): Promise<void> {
    for (const [index, purpose] of order.entries()) {
      if (purpose.sortOrder !== index) {
        await repository.updatePurpose(tx, workspaceId, purpose.id, {
          sortOrder: index,
          updatedAt: dependencies.now(),
        })
      }
    }
  }

  async function moveToPosition(
    tx: Transaction,
    workspaceId: string,
    purpose: ConsentPurposeRecord,
    position: number,
  ): Promise<void> {
    const rows = await repository.purposesForWorkspace(tx, workspaceId)
    const target = rows.find((row) => row.id === purpose.id)
    if (target === undefined) {
      throw AppError.notFound('Consent purpose not found')
    }
    if (position < 0 || position >= rows.length) {
      throw fieldError('sort_order', `Use 0 to ${String(rows.length - 1)}`)
    }
    const reordered = rows.filter((row) => row.id !== purpose.id)
    reordered.splice(position, 0, target)
    await renumber(tx, workspaceId, reordered)
  }

  return {
    async list(actor, filters, query) {
      const workspaceId = requireWorkspaceId(actor)
      const window = readListWindow(query, CONSENT_PURPOSE_SORTS, DEFAULT_CONSENT_PURPOSE_SORT)
      const rows = await repository.listPurposes(dependencies.db, workspaceId, filters, window)
      return mapPage(toPage(rows, window, (row) => row.id), toView)
    },

    async get(actor, id) {
      return toView(await require(requireWorkspaceId(actor), id))
    },

    async create(actor, input) {
      const workspaceId = requireAdminWorkspace(actor)
      validateSlug(input.slug)
      validateLabel(input.label)
      validateDescription(input.description)
      validateDefaultStatus(input.defaultStatus)

      const limit = await limitFor(
        dependencies.entitlements,
        workspaceId,
        CONSENT_PURPOSES_LIMIT.name,
      )
      if (limit !== null) {
        const total = await repository.countPurposes(dependencies.db, workspaceId)
        if (total >= limit) {
          throw new AppError(
            'entitlement_required',
            `Your plan allows ${String(limit)} consent purpose${limit === 1 ? '' : 's'}`,
          )
        }
      }

      const id = dependencies.createId('consentPurpose')

      return dependencies.transaction(
        async ({ tx, events }) => {
          const existing = await repository.purposesForWorkspace(tx, workspaceId)
          if (existing.length >= CONSENT_PURPOSES_HARD_CAP) {
            throw AppError.conflict(
              `A workspace may define at most ${String(CONSENT_PURPOSES_HARD_CAP)} consent purposes`,
              [{ field: 'slug', message: 'Limit reached' }],
            )
          }

          let created: ConsentPurposeRecord
          try {
            created = await repository.insertPurpose(tx, {
              id,
              workspaceId,
              slug: input.slug,
              label: input.label,
              description: input.description,
              defaultStatus: input.defaultStatus,
              sortOrder: (existing.at(-1)?.sortOrder ?? -1) + 1,
            })
          } catch (error: unknown) {
            if (postgresErrorCode(error) === UNIQUE_VIOLATION) {
              throw duplicateSlug()
            }
            throw error
          }

          events.emit(
            'consent_purposes.purpose.created',
            { type: 'consent_purpose', id: created.id },
            { slug: created.slug },
          )

          return toView(created)
        },
        { workspaceId, actor: toEventActor(actor) },
      )
    },

    async update(actor, id, changes) {
      const workspaceId = requireAdminWorkspace(actor)
      const existing = await require(workspaceId, id)

      if (changes.label !== undefined) {
        validateLabel(changes.label)
      }
      if (changes.description !== undefined) {
        validateDescription(changes.description)
      }
      if (changes.defaultStatus !== undefined) {
        validateDefaultStatus(changes.defaultStatus)
      }

      const columns: Partial<repository.ConsentPurposeColumns> = {
        ...(changes.label === undefined ? {} : { label: changes.label }),
        ...(changes.description === undefined ? {} : { description: changes.description }),
        ...(changes.defaultStatus === undefined
          ? {}
          : { defaultStatus: changes.defaultStatus }),
      }
      const changed = changedKeys(existing, columns)
      const position = changes.sortOrder

      if (changed.length === 0 && position === undefined) {
        return toView(existing)
      }

      return dependencies.transaction(
        async ({ tx, events }) => {
          if (position !== undefined) {
            await moveToPosition(tx, workspaceId, existing, position)
          }

          let updated: ConsentPurposeRecord | undefined
          if (changed.length > 0) {
            updated = await repository.updatePurpose(tx, workspaceId, id, {
              ...columns,
              updatedAt: dependencies.now(),
            })
            if (updated === undefined) {
              throw AppError.notFound('Consent purpose not found')
            }
          } else {
            updated = await repository.findPurpose(tx, workspaceId, id)
            if (updated === undefined) {
              throw AppError.notFound('Consent purpose not found')
            }
          }

          if (changed.length > 0 || position !== undefined) {
            const changedPaths = [
              ...changed,
              ...(position !== undefined && position !== existing.sortOrder ? ['sortOrder'] : []),
            ]
            events.emit(
              'consent_purposes.purpose.updated',
              { type: 'consent_purpose', id },
              { slug: updated.slug, changed: changedPaths },
            )
          }

          return toView(updated)
        },
        { workspaceId, actor: toEventActor(actor) },
      )
    },

    async remove(actor, id) {
      const workspaceId = requireAdminWorkspace(actor)
      const existing = await require(workspaceId, id)

      await dependencies.transaction(
        async ({ tx, events }) => {
          const referencing = await referencingTypes(tx, workspaceId, id)
          if (referencing.length > 0) {
            throw AppError.conflict(
              'Remove this purpose from every form field that names it before deleting it',
              referencing.map((type) => ({ field: type, message: 'still references this purpose' })),
            )
          }

          try {
            await repository.deletePurpose(tx, workspaceId, id)
          } catch (error: unknown) {
            if (postgresErrorCode(error) === FOREIGN_KEY_VIOLATION) {
              throw AppError.conflict(
                'Remove this purpose from every form field that names it before deleting it',
                [{ field: 'id', message: 'still referenced' }],
              )
            }
            throw error
          }

          const survivors = await repository.purposesForWorkspace(tx, workspaceId)
          await renumber(tx, workspaceId, survivors)

          events.emit(
            'consent_purposes.purpose.deleted',
            { type: 'consent_purpose', id },
            { slug: existing.slug },
          )
        },
        { workspaceId, actor: toEventActor(actor) },
      )
    },
  }
}
