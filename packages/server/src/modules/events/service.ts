import type { CustomFieldWireValue, EventAssociationTargetType } from '@kelpie/schemas'
import { EVENT_ASSOCIATION_TARGET_TYPES } from '@kelpie/schemas'
import { and, eq, inArray } from 'drizzle-orm'

import { changedKeys } from '../../lib/changes.ts'
import type { Database } from '../../lib/database.ts'
import { AppError } from '../../lib/errors.ts'
import type { IdFactory } from '../../lib/ids.ts'
import { readListWindow, toPage } from '../../lib/pagination.ts'
import type { ListQueryParameters, Page } from '../../lib/pagination.ts'
import { toEventActor } from '../../lib/actor.ts'
import type { TransactionScope } from '../../runtime/transaction.ts'
import type { ActivityRecorder } from '../activities/recorder.ts'
import { describeCreation, describeUpdate } from '../activities/wording.ts'
import type { FieldLabels } from '../activities/wording.ts'
import type { Actor } from '../auth/actor.ts'
import { actorMemberId, requireWorkspaceId } from '../auth/actor.ts'
import { deleteRecordsAttachedTo, deleteRecordsAttachedToAttendancesOf } from '../attachedRecords.ts'
import type { CustomFieldValuesValidator } from '../custom-fields/values.ts'
import { roles } from '../hiring/schema.ts'
import { isRecordTargetType, missingTargets } from '../recordTargets.ts'
import type { RecordTargetType } from '../recordTargets.ts'
import * as workspaceRepository from '../workspace/repository.ts'
import './catalog.ts'
import * as repository from './repository.ts'
import { DEFAULT_EVENT_SORT, EVENT_SORTS } from './repository.ts'
import type { AssociationRef, EventFilters, EventRecord } from './repository.ts'

export interface EventsDependencies {
  readonly db: Database
  readonly transaction: TransactionScope
  readonly createId: IdFactory
  readonly now: () => Date
  readonly recordActivity: ActivityRecorder
  readonly customFields: CustomFieldValuesValidator
}

const EVENT_FIELD_LABELS: FieldLabels = {
  name: 'Name',
  kind: 'Kind',
  startsAt: 'Starts',
  endsAt: 'Ends',
  timezone: 'Timezone',
  location: 'Location',
  meetingUrl: 'Meeting URL',
  format: 'Format',
  details: 'Details',
  status: 'Status',
  ownerId: 'Owner',
  summary: 'Summary',
  tags: 'Tags',
}

export type EventView = Omit<EventRecord, 'workspaceId'> & {
  readonly associations: readonly AssociationRef[]
}

export interface CreateEventInput {
  readonly name: string
  readonly kind: string
  readonly startsAt: Date
  readonly endsAt: Date
  readonly timezone: string | undefined
  readonly location: string
  readonly meetingUrl: string | null
  readonly format: EventRecord['format']
  readonly details: string
  readonly status: EventRecord['status']
  readonly ownerId: string | null | undefined
  readonly summary: string
  readonly tags: readonly string[]
  readonly associations: readonly AssociationRef[]
  readonly customFields: Readonly<Record<string, CustomFieldWireValue | null>> | undefined
}

export interface UpdateEventInput {
  readonly name?: string | undefined
  readonly kind?: string | undefined
  readonly startsAt?: Date | undefined
  readonly endsAt?: Date | undefined
  readonly timezone?: string | undefined
  readonly location?: string | undefined
  readonly meetingUrl?: string | null | undefined
  readonly format?: EventRecord['format'] | undefined
  readonly details?: string | undefined
  readonly status?: EventRecord['status'] | undefined
  readonly ownerId?: string | null | undefined
  readonly summary?: string | undefined
  readonly tags?: readonly string[] | undefined
  readonly associations?: readonly AssociationRef[] | undefined
  readonly customFields?: Readonly<Record<string, CustomFieldWireValue | null>> | undefined
}

export interface EventsService {
  list(actor: Actor, filters: EventFilters, query: ListQueryParameters): Promise<Page<EventView>>
  get(actor: Actor, id: string): Promise<EventView>
  create(actor: Actor, input: CreateEventInput): Promise<EventView>
  update(actor: Actor, id: string, changes: UpdateEventInput): Promise<EventView>
  remove(actor: Actor, id: string): Promise<void>
  listAssociationsFor(
    actor: Actor,
    targetType: EventAssociationTargetType,
    targetId: string,
  ): Promise<readonly { readonly eventId: string; readonly eventName: string }[]>
}

function toView(record: EventRecord, associations: readonly AssociationRef[]): EventView {
  const { workspaceId: _workspaceId, ...view } = record

  return { ...view, associations }
}

function toStoredColumns(input: UpdateEventInput): Partial<repository.EventColumns> {
  return {
    ...(input.name === undefined ? {} : { name: input.name }),
    ...(input.kind === undefined ? {} : { kind: input.kind }),
    ...(input.startsAt === undefined ? {} : { startsAt: input.startsAt }),
    ...(input.endsAt === undefined ? {} : { endsAt: input.endsAt }),
    ...(input.timezone === undefined ? {} : { timezone: input.timezone }),
    ...(input.location === undefined ? {} : { location: input.location }),
    ...(input.meetingUrl === undefined ? {} : { meetingUrl: input.meetingUrl }),
    ...(input.format === undefined ? {} : { format: input.format }),
    ...(input.details === undefined ? {} : { details: input.details }),
    ...(input.status === undefined ? {} : { status: input.status }),
    ...(input.ownerId === undefined ? {} : { ownerId: input.ownerId }),
    ...(input.summary === undefined ? {} : { summary: input.summary }),
    ...(input.tags === undefined ? {} : { tags: [...input.tags] }),
  }
}

function requireRange(startsAt: Date, endsAt: Date): void {
  if (endsAt.getTime() < startsAt.getTime()) {
    throw AppError.validationFailed('The event cannot end before it starts', [
      { field: 'ends_at', message: 'Must be on or after starts_at' },
    ])
  }
}

function uniqueAssociations(rows: readonly AssociationRef[]): AssociationRef[] {
  const seen = new Set<string>()
  const unique: AssociationRef[] = []

  for (const row of rows) {
    const key = `${row.targetType}:${row.targetId}`

    if (seen.has(key)) {
      continue
    }

    seen.add(key)
    unique.push(row)
  }

  return unique
}

export function createEventsService(dependencies: EventsDependencies): EventsService {
  async function require(workspaceId: string, id: string): Promise<EventRecord> {
    const event = await repository.findEvent(dependencies.db, workspaceId, id)

    if (event === undefined) {
      throw AppError.notFound('Event not found')
    }

    return event
  }

  async function requireOwner(workspaceId: string, ownerId: string): Promise<void> {
    if (!(await repository.memberExists(dependencies.db, workspaceId, ownerId))) {
      throw AppError.notFound('Team member not found')
    }
  }

  async function defaultTimezone(workspaceId: string): Promise<string> {
    const workspace = await workspaceRepository.findWorkspace(dependencies.db, workspaceId)

    return workspace?.timezone ?? 'UTC'
  }

  async function requireAssociations(
    workspaceId: string,
    rows: readonly AssociationRef[],
  ): Promise<void> {
    const problems: { field: string; message: string }[] = []

    for (const kind of EVENT_ASSOCIATION_TARGET_TYPES) {
      const ofKind = rows.filter((row) => row.targetType === kind)

      if (ofKind.length === 0) {
        continue
      }

      const ids = ofKind.map((row) => row.targetId)
      let missing: readonly string[]

      if (kind === 'role') {
        const found = await dependencies.db
          .select({ id: roles.id })
          .from(roles)
          .where(and(eq(roles.workspaceId, workspaceId), inArray(roles.id, [...ids])))
        const existing = new Set(found.map((row) => row.id))

        missing = ids.filter((id) => !existing.has(id))
      } else if (isRecordTargetType(kind)) {
        missing = await missingTargets(dependencies.db, workspaceId, kind as RecordTargetType, ids)
      } else {
        missing = ids
      }

      if (missing.length === 0) {
        continue
      }

      const missingSet = new Set(missing)

      rows.forEach((row, index) => {
        if (row.targetType === kind && missingSet.has(row.targetId)) {
          problems.push({
            field: `associations.${String(index)}`,
            message: `No ${kind} ${row.targetId} here`,
          })
        }
      })
    }

    if (problems.length > 0) {
      throw new AppError('not_found', 'Association target not found', problems)
    }
  }

  async function toViews(
    workspaceId: string,
    records: readonly EventRecord[],
  ): Promise<EventView[]> {
    return Promise.all(
      records.map(async (record) =>
        toView(record, await repository.listAssociations(dependencies.db, workspaceId, record.id)),
      ),
    )
  }

  return {
    async list(actor, filters, query) {
      const workspaceId = requireWorkspaceId(actor)
      const window = readListWindow(query, EVENT_SORTS, DEFAULT_EVENT_SORT)
      const rows = await repository.listEvents(dependencies.db, workspaceId, filters, window)
      const page = toPage(rows, window, (event) => event.id)

      return { items: await toViews(workspaceId, page.items), nextCursor: page.nextCursor }
    },

    async get(actor, id) {
      const workspaceId = requireWorkspaceId(actor)
      const event = await require(workspaceId, id)

      return toView(event, await repository.listAssociations(dependencies.db, workspaceId, id))
    },

    async create(actor, input) {
      const workspaceId = requireWorkspaceId(actor)

      requireRange(input.startsAt, input.endsAt)

      const ownerId = input.ownerId === undefined ? actorMemberId(actor) : input.ownerId

      if (ownerId !== null) {
        await requireOwner(workspaceId, ownerId)
      }

      const associations = uniqueAssociations(input.associations)

      await requireAssociations(workspaceId, associations)

      const timezone = input.timezone ?? (await defaultTimezone(workspaceId))
      const id = dependencies.createId('crmEvent')

      return dependencies.transaction(
        async ({ tx, events }) => {
          const customFields = await dependencies.customFields.forCreate(
            tx,
            workspaceId,
            'event',
            input.customFields,
          )
          const created = await repository.insertEvent(tx, {
            id,
            workspaceId,
            name: input.name,
            kind: input.kind,
            startsAt: input.startsAt,
            endsAt: input.endsAt,
            timezone,
            location: input.location,
            meetingUrl: input.meetingUrl,
            format: input.format,
            details: input.details,
            status: input.status,
            ownerId,
            summary: input.summary,
            tags: [...input.tags],
            customFields,
          })

          await repository.replaceAssociations(
            tx,
            dependencies.createId,
            workspaceId,
            id,
            associations,
          )

          await dependencies.recordActivity(tx, workspaceId, actor, {
            targetType: 'event',
            targetId: id,
            kind: 'created',
            ...describeCreation('Event'),
          })

          events.emit('events.event.created', { type: 'event', id }, {})

          return toView(created, associations)
        },
        { workspaceId, actor: toEventActor(actor) },
      )
    },

    async update(actor, id, changes) {
      const workspaceId = requireWorkspaceId(actor)
      const existing = await require(workspaceId, id)

      const startsAt = changes.startsAt ?? existing.startsAt
      const endsAt = changes.endsAt ?? existing.endsAt

      requireRange(startsAt, endsAt)

      if (typeof changes.ownerId === 'string' && changes.ownerId !== existing.ownerId) {
        await requireOwner(workspaceId, changes.ownerId)
      }

      const current = await repository.listAssociations(dependencies.db, workspaceId, id)
      const next =
        changes.associations === undefined ? undefined : uniqueAssociations(changes.associations)

      if (next !== undefined) {
        await requireAssociations(workspaceId, next)
      }

      const columns = toStoredColumns(changes)
      const scalarChanged = changedKeys(existing, columns)
      const linksChanged =
        next !== undefined && JSON.stringify(current) !== JSON.stringify(next)

      return dependencies.transaction(
        async ({ tx, events }) => {
          const cf = await dependencies.customFields.forUpdate(
            tx,
            workspaceId,
            'event',
            existing.customFields,
            changes.customFields,
          )
          const customFieldsChanged = cf !== undefined && cf.changedPaths.length > 0

          if (scalarChanged.length === 0 && !linksChanged && !customFieldsChanged) {
            return toView(existing, current)
          }

          const updated = await repository.updateEvent(tx, workspaceId, id, {
            ...columns,
            ...(customFieldsChanged ? { customFields: cf.merged } : {}),
            updatedAt: dependencies.now(),
          })

          if (updated === undefined) {
            throw AppError.notFound('Event not found')
          }

          if (next !== undefined) {
            await repository.replaceAssociations(
              tx,
              dependencies.createId,
              workspaceId,
              id,
              next,
            )
          }

          if (scalarChanged.length > 0 || customFieldsChanged) {
            const labels: Record<string, string> = { ...EVENT_FIELD_LABELS, ...cf?.labels }
            const before: Record<string, unknown> = { ...existing, ...cf?.flatBefore }
            const after: Record<string, unknown> = { ...columns, ...cf?.flatAfter }
            const activityChanged = [
              ...scalarChanged,
              ...(cf?.changedPaths ?? []),
            ]

            await dependencies.recordActivity(tx, workspaceId, actor, {
              targetType: 'event',
              targetId: id,
              kind: 'updated',
              ...describeUpdate(activityChanged, labels, before, after),
            })
          }

          const changed = [
            ...scalarChanged,
            ...(linksChanged ? ['associations'] : []),
            ...(customFieldsChanged ? cf.changedPaths : []),
          ]

          events.emit('events.event.updated', { type: 'event', id }, { changed })

          return toView(updated, next ?? current)
        },
        { workspaceId, actor: toEventActor(actor) },
      )
    },

    async remove(actor, id) {
      const workspaceId = requireWorkspaceId(actor)

      await require(workspaceId, id)

      await dependencies.transaction(
        async ({ tx, events }) => {
          await deleteRecordsAttachedToAttendancesOf(tx, workspaceId, { eventId: id })
          await deleteRecordsAttachedTo(tx, workspaceId, 'event', id)
          await repository.deleteEvent(tx, workspaceId, id)
          events.emit('events.event.deleted', { type: 'event', id }, {})
        },
        { workspaceId, actor: toEventActor(actor) },
      )
    },

    async listAssociationsFor(actor, targetType, targetId) {
      const workspaceId = requireWorkspaceId(actor)

      await requireAssociations(workspaceId, [{ targetType, targetId }])

      return repository.listAssociationsByTarget(dependencies.db, workspaceId, targetType, targetId)
    },
  }
}
