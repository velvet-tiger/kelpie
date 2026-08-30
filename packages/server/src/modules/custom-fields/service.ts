import { changedKeys } from '../../lib/changes.ts'
import { UNIQUE_VIOLATION, postgresErrorCode } from '../../lib/database.ts'
import type { Database } from '../../lib/database.ts'
import { AppError } from '../../lib/errors.ts'
import type { IdFactory } from '../../lib/ids.ts'
import { mapPage, readListWindow, toPage } from '../../lib/pagination.ts'
import type { ListQueryParameters, Page } from '../../lib/pagination.ts'
import { toEventActor } from '../../lib/actor.ts'
import type { EntitlementRegistry } from '../../runtime/entitlements.ts'
import { limitFor } from '../../runtime/entitlements.ts'
import type { Transaction, TransactionScope } from '../../runtime/transaction.ts'
import type { Actor } from '../auth/actor.ts'
import { requireWorkspaceId } from '../auth/actor.ts'
import { roleAllows } from '../workspace/roles.ts'
import { CUSTOM_FIELDS_LIMIT } from './capabilities.ts'
import './events.ts'
import * as repository from './repository.ts'
import {
  CUSTOM_FIELD_DEFINITION_SORTS,
  DEFAULT_CUSTOM_FIELD_DEFINITION_SORT,
} from './repository.ts'
import type {
  CustomFieldDefinitionFilters,
  CustomFieldDefinitionRecord,
} from './repository.ts'
import { CUSTOM_FIELD_OBJECT_TYPES } from './schema.ts'
import type { CustomFieldObjectType, CustomFieldType } from './schema.ts'

/**
 * Definition-side CRUD for custom fields.
 *
 * Reads are open to any workspace actor: agents that write values must be able
 * to list definitions first, and detail pages fetch them for every viewer.
 * Writes require the admin role, matching how API keys and webhooks are gated
 * — a definition changes the shape of every record of one object type and is
 * team-wide config, not a per-user preference.
 *
 * The record-side write path lives in `values.ts`: create/update pass their
 * sent `custom_fields` through `createCustomFieldValues(...).forCreate` /
 * `.forUpdate`, which reads definitions and enforces per-type validity.
 */

/** Hard cap per (workspace, object_type). Bites when the entitlement leaves the count unlimited. */
export const CUSTOM_FIELDS_PER_OBJECT_HARD_CAP = 100

const KEY_PATTERN = /^[a-z][a-z0-9_]*$/u
const MAX_KEY_LENGTH = 64
const MAX_LABEL_LENGTH = 120
const MIN_LABEL_LENGTH = 1
const MAX_DESCRIPTION_LENGTH = 2000
const MAX_OPTIONS = 100
const MIN_OPTION_LENGTH = 1
const MAX_OPTION_LENGTH = 120

/** The wire types that require a non-empty `options`. */
const TYPES_WITH_OPTIONS: ReadonlySet<CustomFieldType> = new Set(['select', 'multi_select'])

export interface CustomFieldDefinitionsDependencies {
  readonly db: Database
  readonly transaction: TransactionScope
  readonly createId: IdFactory
  readonly now: () => Date
  readonly entitlements: EntitlementRegistry
}

/** The definition as the API returns it: the stored row minus the tenancy column. */
export type CustomFieldDefinitionView = Omit<CustomFieldDefinitionRecord, 'workspaceId'>

export interface CreateCustomFieldDefinitionInput {
  readonly objectType: CustomFieldObjectType
  readonly key: string
  readonly label: string
  readonly type: CustomFieldType
  readonly options: readonly string[]
  readonly description: string
}

/** PATCH semantics: `key`, `type`, `object_type` are immutable and refused by the route body. */
export interface UpdateCustomFieldDefinitionInput {
  readonly label?: string | undefined
  readonly description?: string | undefined
  readonly options?: readonly string[] | undefined
  readonly sortOrder?: number | undefined
}

export interface CustomFieldDefinitionsService {
  list(
    actor: Actor,
    filters: CustomFieldDefinitionFilters,
    query: ListQueryParameters,
  ): Promise<Page<CustomFieldDefinitionView>>
  get(actor: Actor, id: string): Promise<CustomFieldDefinitionView>
  create(
    actor: Actor,
    input: CreateCustomFieldDefinitionInput,
  ): Promise<CustomFieldDefinitionView>
  update(
    actor: Actor,
    id: string,
    changes: UpdateCustomFieldDefinitionInput,
  ): Promise<CustomFieldDefinitionView>
  remove(actor: Actor, id: string): Promise<void>
}

function toView(record: CustomFieldDefinitionRecord): CustomFieldDefinitionView {
  const { workspaceId: _workspaceId, ...view } = record
  return view
}

function duplicateKey(): AppError {
  return AppError.conflict(
    'Another custom field on this object type already has that key',
    [{ field: 'key', message: 'Already in use' }],
  )
}

function fieldError(field: string, message: string): AppError {
  return AppError.validationFailed('That custom field is not valid', [{ field, message }])
}

function validateKey(key: string): void {
  if (key.length === 0 || key.length > MAX_KEY_LENGTH) {
    throw fieldError('key', `1 to ${String(MAX_KEY_LENGTH)} characters`)
  }
  if (!KEY_PATTERN.test(key)) {
    throw fieldError(
      'key',
      'Lowercase letters, digits and underscores; must start with a letter',
    )
  }
}

function validateLabel(label: string): void {
  if (label.length < MIN_LABEL_LENGTH || label.length > MAX_LABEL_LENGTH) {
    throw fieldError('label', `${String(MIN_LABEL_LENGTH)} to ${String(MAX_LABEL_LENGTH)} characters`)
  }
}

function validateDescription(description: string): void {
  if (description.length > MAX_DESCRIPTION_LENGTH) {
    throw fieldError('description', `At most ${String(MAX_DESCRIPTION_LENGTH)} characters`)
  }
}

function validateOptionsFor(type: CustomFieldType, options: readonly string[]): void {
  const requiresOptions = TYPES_WITH_OPTIONS.has(type)
  if (!requiresOptions) {
    if (options.length > 0) {
      throw fieldError('options', 'Only select and multi_select fields carry options')
    }
    return
  }
  if (options.length === 0) {
    throw fieldError('options', 'Select fields need at least one option')
  }
  if (options.length > MAX_OPTIONS) {
    throw fieldError('options', `At most ${String(MAX_OPTIONS)} options`)
  }
  const seen = new Set<string>()
  for (const option of options) {
    if (option.length < MIN_OPTION_LENGTH || option.length > MAX_OPTION_LENGTH) {
      throw fieldError(
        'options',
        `Each option is ${String(MIN_OPTION_LENGTH)} to ${String(MAX_OPTION_LENGTH)} characters`,
      )
    }
    if (seen.has(option)) {
      throw fieldError('options', `"${option}" appears more than once`)
    }
    seen.add(option)
  }
}

function assertObjectType(objectType: string): asserts objectType is CustomFieldObjectType {
  if (!CUSTOM_FIELD_OBJECT_TYPES.includes(objectType as CustomFieldObjectType)) {
    throw fieldError('object_type', `Unknown object type "${objectType}"`)
  }
}

export function createCustomFieldDefinitionsService(
  dependencies: CustomFieldDefinitionsDependencies,
): CustomFieldDefinitionsService {
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
  ): Promise<CustomFieldDefinitionRecord> {
    const definition = await repository.findDefinition(dependencies.db, workspaceId, id)
    if (definition === undefined) {
      throw AppError.notFound('Custom field not found')
    }
    return definition
  }

  /**
   * Renumbers the sort_order of one object type's definitions to 0..N-1 in
   * `order`, writing only the rows whose position moved. Mirrors the pipeline
   * stage renumber pattern.
   */
  async function renumber(
    tx: Transaction,
    workspaceId: string,
    order: readonly CustomFieldDefinitionRecord[],
  ): Promise<void> {
    for (const [index, definition] of order.entries()) {
      if (definition.sortOrder !== index) {
        await repository.updateDefinition(tx, workspaceId, definition.id, {
          sortOrder: index,
          updatedAt: dependencies.now(),
        })
      }
    }
  }

  async function moveToPosition(
    tx: Transaction,
    workspaceId: string,
    definition: CustomFieldDefinitionRecord,
    position: number,
  ): Promise<void> {
    const rows = await repository.definitionsForObject(
      tx,
      workspaceId,
      definition.objectType as CustomFieldObjectType,
    )
    const target = rows.find((row) => row.id === definition.id)
    if (target === undefined) {
      throw AppError.notFound('Custom field not found')
    }
    if (position < 0 || position >= rows.length) {
      throw fieldError('sort_order', `Use 0 to ${String(rows.length - 1)}`)
    }
    const reordered = rows.filter((row) => row.id !== definition.id)
    reordered.splice(position, 0, target)
    await renumber(tx, workspaceId, reordered)
  }

  return {
    async list(actor, filters, query) {
      const workspaceId = requireWorkspaceId(actor)
      const window = readListWindow(
        query,
        CUSTOM_FIELD_DEFINITION_SORTS,
        DEFAULT_CUSTOM_FIELD_DEFINITION_SORT,
      )
      const rows = await repository.listDefinitions(
        dependencies.db,
        workspaceId,
        filters,
        window,
      )
      return mapPage(toPage(rows, window, (row) => row.id), toView)
    },

    async get(actor, id) {
      return toView(await require(requireWorkspaceId(actor), id))
    },

    async create(actor, input) {
      const workspaceId = requireAdminWorkspace(actor)
      assertObjectType(input.objectType)
      validateKey(input.key)
      validateLabel(input.label)
      validateDescription(input.description)
      validateOptionsFor(input.type, input.options)

      const limit = await limitFor(dependencies.entitlements, workspaceId, CUSTOM_FIELDS_LIMIT.name)
      if (limit !== null) {
        const total = await repository.countDefinitions(dependencies.db, workspaceId)
        if (total >= limit) {
          throw new AppError(
            'entitlement_required',
            `Your plan allows ${String(limit)} custom field${limit === 1 ? '' : 's'}`,
          )
        }
      }

      const id = dependencies.createId('customFieldDefinition')

      return dependencies.transaction(
        async ({ tx, events }) => {
          const existing = await repository.definitionsForObject(tx, workspaceId, input.objectType)
          if (existing.length >= CUSTOM_FIELDS_PER_OBJECT_HARD_CAP) {
            throw AppError.conflict(
              `A record type may carry at most ${String(CUSTOM_FIELDS_PER_OBJECT_HARD_CAP)} custom fields`,
              [{ field: 'object_type', message: 'Limit reached' }],
            )
          }

          let created: CustomFieldDefinitionRecord
          try {
            created = await repository.insertDefinition(tx, {
              id,
              workspaceId,
              objectType: input.objectType,
              key: input.key,
              label: input.label,
              type: input.type,
              options: input.options,
              description: input.description,
              sortOrder: (existing.at(-1)?.sortOrder ?? -1) + 1,
            })
          } catch (error: unknown) {
            if (postgresErrorCode(error) === UNIQUE_VIOLATION) {
              throw duplicateKey()
            }
            throw error
          }

          events.emit(
            'custom_fields.field.created',
            { type: 'custom_field', id: created.id },
            { objectType: created.objectType, key: created.key },
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
      if (changes.options !== undefined) {
        validateOptionsFor(existing.type as CustomFieldType, changes.options)
      }

      const columns: Partial<repository.CustomFieldDefinitionColumns> = {
        ...(changes.label === undefined ? {} : { label: changes.label }),
        ...(changes.description === undefined ? {} : { description: changes.description }),
        ...(changes.options === undefined ? {} : { options: changes.options }),
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

          let updated: CustomFieldDefinitionRecord | undefined
          if (changed.length > 0) {
            updated = await repository.updateDefinition(tx, workspaceId, id, {
              ...columns,
              updatedAt: dependencies.now(),
            })
            if (updated === undefined) {
              throw AppError.notFound('Custom field not found')
            }
          } else {
            updated = await repository.findDefinition(tx, workspaceId, id)
            if (updated === undefined) {
              throw AppError.notFound('Custom field not found')
            }
          }

          if (changed.length > 0 || position !== undefined) {
            const changedPaths = [
              ...changed,
              ...(position !== undefined && position !== existing.sortOrder ? ['sortOrder'] : []),
            ]
            events.emit(
              'custom_fields.field.updated',
              { type: 'custom_field', id },
              {
                objectType: updated.objectType,
                key: updated.key,
                changed: changedPaths,
              },
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
          const stripped = await repository.stripKeyFromRecords(
            tx,
            workspaceId,
            existing.objectType as CustomFieldObjectType,
            existing.key,
          )
          await repository.deleteDefinition(tx, workspaceId, id)
          // Renumber survivors so `sort_order` stays contiguous, same as the
          // pipelines remove path.
          const survivors = await repository.definitionsForObject(
            tx,
            workspaceId,
            existing.objectType as CustomFieldObjectType,
          )
          await renumber(tx, workspaceId, survivors)

          // No per-record `<object>.updated` events for the strip: a definition
          // delete may touch thousands of rows and would flood every webhook
          // subscriber. The `custom_fields.field.deleted` event carries the
          // count for a consumer that wants to know how many rows were touched.
          events.emit(
            'custom_fields.field.deleted',
            { type: 'custom_field', id },
            {
              objectType: existing.objectType,
              key: existing.key,
              strippedRecordCount: stripped,
            },
          )
        },
        { workspaceId, actor: toEventActor(actor) },
      )
    },
  }
}
