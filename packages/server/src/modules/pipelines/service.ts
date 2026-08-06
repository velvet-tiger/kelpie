import { changedKeys } from '../../lib/changes.ts'
import { UNIQUE_VIOLATION, isReferenceViolation, postgresErrorCode } from '../../lib/database.ts'
import type { Database } from '../../lib/database.ts'
import { AppError } from '../../lib/errors.ts'
import type { IdFactory } from '../../lib/ids.ts'
import { mapPage, readListWindow, toPage } from '../../lib/pagination.ts'
import type { ListQueryParameters, Page } from '../../lib/pagination.ts'
import type { Transaction, TransactionScope } from '../../runtime/transaction.ts'
import type { ActivityRecorder } from '../activities/recorder.ts'
import { describeStageChange } from '../activities/wording.ts'
import type { Actor } from '../auth/actor.ts'
import { requireWorkspaceId } from '../auth/actor.ts'
import { referencedElsewhere } from '../references.ts'
import { reassignStagedRecords } from '../stagedRecords.ts'
import * as repository from './repository.ts'
import { DEFAULT_PIPELINE_STAGE_SORT, PIPELINE_STAGE_SORTS } from './repository.ts'
import type { PipelineStageFilters, PipelineStageRecord } from './repository.ts'
import { PIPELINE_KINDS } from './schema.ts'
import type { PipelineKind } from './schema.ts'

/**
 * Stage configuration for the four pipelines: what the board's columns are.
 *
 * Stages are workspace config, not CRM records: changing one writes no activity
 * and emits no `record.*` event. The exception is remove-with-reassign, where the
 * records forced out of the removed stage each get the same `stage_changed`
 * activity and `stage.changed` event a hand move would have produced.
 */

export interface PipelinesDependencies {
  readonly db: Database
  readonly transaction: TransactionScope
  readonly createId: IdFactory
  readonly now: () => Date
  readonly recordActivity: ActivityRecorder
}

/** A stage as the API returns one: the stored row minus the tenancy column. */
export type PipelineStageView = Omit<PipelineStageRecord, 'workspaceId'>

export interface CreateStageInput {
  readonly kind: PipelineKind
  readonly label: string
  readonly open: boolean
}

export interface UpdateStageInput {
  readonly label?: string | undefined
  readonly open?: boolean | undefined
  /** The stage's new position on the board, 0-based. The others shift around it. */
  readonly sortOrder?: number | undefined
}

export interface PipelineStagesService {
  list(
    actor: Actor,
    filters: PipelineStageFilters,
    query: ListQueryParameters,
  ): Promise<Page<PipelineStageView>>
  get(actor: Actor, id: string): Promise<PipelineStageView>
  create(actor: Actor, input: CreateStageInput): Promise<PipelineStageView>
  update(actor: Actor, id: string, changes: UpdateStageInput): Promise<PipelineStageView>
  /**
   * @param moveToId Where the records standing in the removed stage go. Omitted
   *   is the same as absent: the removal refuses if the stage still holds any.
   */
  remove(actor: Actor, id: string, moveToId?: string | undefined): Promise<void>
}

function toView(record: PipelineStageRecord): PipelineStageView {
  const { workspaceId: _workspaceId, ...view } = record

  return view
}

/**
 * The stored `kind`, narrowed back to the fixed set the check constraint
 * enforces. A row outside it is corrupt data, so this failing is a 500, not a 4xx.
 */
function stageKind(stage: PipelineStageRecord): PipelineKind {
  const kind = PIPELINE_KINDS.find((candidate) => candidate === stage.kind)

  if (kind === undefined) {
    throw new Error(`Pipeline stage ${stage.id} has unknown kind "${stage.kind}"`)
  }

  return kind
}

/**
 * The import-alias slug for a new stage, derived from its label the way the
 * starter slugs are written: lowercase, runs of anything else collapsed to one
 * underscore. `Term sheet` → `term_sheet`.
 */
function slugFromLabel(label: string): string {
  const slug = label
    .normalize('NFKD')
    .replace(/[̀-ͯ]/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '_')
    .replace(/^_+|_+$/gu, '')

  return slug.length === 0 ? 'stage' : slug
}

/** `won`, `won_2`, `won_3`: labels may repeat, the import alias may not. */
function uniqueSlug(taken: ReadonlySet<string>, base: string): string {
  if (!taken.has(base)) {
    return base
  }

  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${base}_${String(suffix)}`

    if (!taken.has(candidate)) {
      return candidate
    }
  }
}

function duplicateSlug(): AppError {
  return AppError.conflict('A stage with that name was just created in this pipeline', [
    { field: 'label', message: 'Try again' },
  ])
}

export function createPipelineStagesService(
  dependencies: PipelinesDependencies,
): PipelineStagesService {
  async function require(workspaceId: string, id: string): Promise<PipelineStageRecord> {
    const stage = await repository.findStage(dependencies.db, workspaceId, id)

    if (stage === undefined) {
      throw AppError.notFound('Pipeline stage not found')
    }

    return stage
  }

  /**
   * Renumbers one pipeline to `order`, writing only the rows whose position
   * moved. Sort orders stay contiguous from 0, which is what lets a PATCHed
   * `sort_order` mean "position on the board".
   */
  async function renumber(
    tx: Transaction,
    workspaceId: string,
    order: readonly PipelineStageRecord[],
  ): Promise<void> {
    for (const [index, stage] of order.entries()) {
      if (stage.sortOrder !== index) {
        await repository.updateStage(tx, workspaceId, stage.id, {
          sortOrder: index,
          updatedAt: dependencies.now(),
        })
      }
    }
  }

  async function moveToPosition(
    tx: Transaction,
    workspaceId: string,
    stage: PipelineStageRecord,
    position: number,
  ): Promise<void> {
    const rows = await repository.listStagesOfKind(tx, workspaceId, stageKind(stage))
    const target = rows.find((row) => row.id === stage.id)

    if (target === undefined) {
      throw AppError.notFound('Pipeline stage not found')
    }

    if (position >= rows.length) {
      throw AppError.validationFailed('That position is past the end of the pipeline', [
        { field: 'sort_order', message: `Use 0 to ${String(rows.length - 1)}` },
      ])
    }

    const reordered = rows.filter((row) => row.id !== stage.id)

    reordered.splice(position, 0, target)
    await renumber(tx, workspaceId, reordered)
  }

  return {
    async list(actor, filters, query) {
      const workspaceId = requireWorkspaceId(actor)
      const window = readListWindow(query, PIPELINE_STAGE_SORTS, DEFAULT_PIPELINE_STAGE_SORT)
      const rows = await repository.listStages(dependencies.db, workspaceId, filters, window)

      return mapPage(toPage(rows, window, (stage) => stage.id), toView)
    },

    async get(actor, id) {
      return toView(await require(requireWorkspaceId(actor), id))
    },

    async create(actor, input) {
      const workspaceId = requireWorkspaceId(actor)
      const id = dependencies.createId('pipelineStage')

      return dependencies.transaction(async ({ tx }) => {
        const rows = await repository.listStagesOfKind(tx, workspaceId, input.kind)
        const slug = uniqueSlug(new Set(rows.map((row) => row.slug)), slugFromLabel(input.label))

        try {
          const created = await repository.insertStage(tx, {
            id,
            workspaceId,
            kind: input.kind,
            slug,
            label: input.label,
            open: input.open,
            sortOrder: (rows.at(-1)?.sortOrder ?? -1) + 1,
          })

          return toView(created)
        } catch (error: unknown) {
          // Two concurrent creates can derive the same slug from the same read.
          if (postgresErrorCode(error) === UNIQUE_VIOLATION) {
            throw duplicateSlug()
          }

          throw error
        }
      })
    },

    async update(actor, id, changes) {
      const workspaceId = requireWorkspaceId(actor)
      const existing = await require(workspaceId, id)
      const columns = {
        ...(changes.label === undefined ? {} : { label: changes.label }),
        ...(changes.open === undefined ? {} : { open: changes.open }),
      }
      const changed = changedKeys(existing, columns)
      const position = changes.sortOrder

      if (changed.length === 0 && position === undefined) {
        return toView(existing)
      }

      return dependencies.transaction(async ({ tx }) => {
        if (position !== undefined) {
          await moveToPosition(tx, workspaceId, existing, position)
        }

        if (changed.length > 0) {
          const updated = await repository.updateStage(tx, workspaceId, id, {
            ...columns,
            updatedAt: dependencies.now(),
          })

          if (updated === undefined) {
            throw AppError.notFound('Pipeline stage not found')
          }

          return toView(updated)
        }

        const moved = await repository.findStage(tx, workspaceId, id)

        if (moved === undefined) {
          throw AppError.notFound('Pipeline stage not found')
        }

        return toView(moved)
      })
    },

    async remove(actor, id, moveToId) {
      const workspaceId = requireWorkspaceId(actor)
      const stage = await require(workspaceId, id)
      const kind = stageKind(stage)

      await dependencies.transaction(async ({ tx, events }) => {
        const rows = await repository.listStagesOfKind(tx, workspaceId, kind)

        // A pipeline with no stages would leave its records nowhere to sit and
        // its board nothing to render. The mockup disables the last Remove
        // button; the API refuses regardless of who is calling.
        if (rows.length <= 1) {
          throw AppError.conflict('A pipeline needs at least one stage', [
            { field: 'id', message: 'This is the last stage of this pipeline' },
          ])
        }

        if (moveToId !== undefined) {
          const moveTo = rows.find((row) => row.id === moveToId)

          if (moveTo === undefined || moveTo.id === stage.id) {
            throw AppError.validationFailed('Records can only move to another stage of the same pipeline', [
              { field: 'move_to', message: `Use another ${kind} stage in this workspace` },
            ])
          }

          const movedIds = await reassignStagedRecords(tx, kind, {
            workspaceId,
            fromStageId: stage.id,
            toStageId: moveTo.id,
            movedAt: dependencies.now(),
          })

          // The same trail a hand move leaves, once per displaced record: the
          // timeline should say why a deal is suddenly in another column.
          for (const recordId of movedIds) {
            await dependencies.recordActivity(tx, workspaceId, actor, {
              targetType: kind,
              targetId: recordId,
              kind: 'stage_changed',
              ...describeStageChange(stage.label, moveTo.label),
            })
            events.emit('stage.changed', {
              workspaceId,
              objectType: kind,
              recordId,
              fromStageId: stage.id,
              toStageId: moveTo.id,
            })
          }
        }

        try {
          await repository.deleteStage(tx, workspaceId, id)
        } catch (error: unknown) {
          // No `move_to` and records still in the stage: the restrict foreign
          // key refuses, and the caller learns what to pass next time.
          if (isReferenceViolation(error)) {
            throw referencedElsewhere(error, 'pipeline stage')
          }

          throw error
        }

        await renumber(tx, workspaceId, rows.filter((row) => row.id !== id))
      })
    },
  }
}
