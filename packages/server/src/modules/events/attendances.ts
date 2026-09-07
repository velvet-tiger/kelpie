import { ATTENDANCE_STATUS_LABELS } from '@kelpie/schemas'
import type { AttendanceSource, AttendanceStatus } from '@kelpie/schemas'

import { changedKeys } from '../../lib/changes.ts'
import { UNIQUE_VIOLATION, postgresErrorCode } from '../../lib/database.ts'
import type { Database } from '../../lib/database.ts'
import { AppError } from '../../lib/errors.ts'
import type { IdFactory } from '../../lib/ids.ts'
import { mapPage, readListWindow, toPage } from '../../lib/pagination.ts'
import type { ListQueryParameters, Page } from '../../lib/pagination.ts'
import { toEventActor } from '../../lib/actor.ts'
import type { TransactionScope } from '../../runtime/transaction.ts'
import type { ActivityRecorder } from '../activities/recorder.ts'
import { describeLink, describeUnlink, describeUpdate } from '../activities/wording.ts'
import type { FieldLabels } from '../activities/wording.ts'
import type { Actor } from '../auth/actor.ts'
import { requireWorkspaceId } from '../auth/actor.ts'
import { deleteRecordsAttachedTo } from '../attachedRecords.ts'
import * as personLinks from '../personLinks.ts'
import './catalog.ts'
import * as repository from './repository.ts'
import { ATTENDANCE_SORTS, DEFAULT_ATTENDANCE_SORT } from './repository.ts'
import type { AttendanceFilters, AttendanceRecord } from './repository.ts'

export interface AttendancesDependencies {
  readonly db: Database
  readonly transaction: TransactionScope
  readonly createId: IdFactory
  readonly now: () => Date
  readonly recordActivity: ActivityRecorder
}

const ATTENDANCE_FIELD_LABELS: FieldLabels = {
  status: 'Attendance status',
}

export type AttendanceView = Omit<AttendanceRecord, 'workspaceId'>

export interface CreateAttendanceInput {
  readonly eventId: string
  readonly personId: string
  readonly status: AttendanceStatus
  readonly source: AttendanceSource
}

export interface UpdateAttendanceInput {
  readonly status?: AttendanceStatus | undefined
}

export interface AttendancesService {
  list(
    actor: Actor,
    filters: AttendanceFilters,
    query: ListQueryParameters,
  ): Promise<Page<AttendanceView>>
  get(actor: Actor, id: string): Promise<AttendanceView>
  create(actor: Actor, input: CreateAttendanceInput): Promise<AttendanceView>
  update(actor: Actor, id: string, changes: UpdateAttendanceInput): Promise<AttendanceView>
  remove(actor: Actor, id: string): Promise<void>
}

function toView(record: AttendanceRecord): AttendanceView {
  const { workspaceId: _workspaceId, ...view } = record

  return view
}

function duplicateAttendance(): AppError {
  return AppError.conflict('That person is already registered for that event', [
    { field: 'person_id', message: 'Already registered for this event' },
  ])
}

export function createAttendancesService(
  dependencies: AttendancesDependencies,
): AttendancesService {
  async function require(workspaceId: string, id: string): Promise<AttendanceRecord> {
    const row = await repository.findAttendance(dependencies.db, workspaceId, id)

    if (row === undefined) {
      throw AppError.notFound('Attendance not found')
    }

    return row
  }

  async function requireEvent(workspaceId: string, eventId: string): Promise<string> {
    const event = await repository.findEvent(dependencies.db, workspaceId, eventId)

    if (event === undefined) {
      throw AppError.notFound('Event not found')
    }

    return event.name
  }

  async function requirePerson(workspaceId: string, personId: string): Promise<string> {
    const named = await personLinks.findPeopleNamed(dependencies.db, workspaceId, [personId])
    const name = named.get(personId)

    if (name === undefined) {
      throw AppError.notFound('Person not found')
    }

    return name
  }

  return {
    async list(actor, filters, query) {
      const workspaceId = requireWorkspaceId(actor)
      const window = readListWindow(query, ATTENDANCE_SORTS, DEFAULT_ATTENDANCE_SORT)
      const rows = await repository.listAttendances(dependencies.db, workspaceId, filters, window)

      return mapPage(toPage(rows, window, (row) => row.id), toView)
    },

    async get(actor, id) {
      return toView(await require(requireWorkspaceId(actor), id))
    },

    async create(actor, input) {
      const workspaceId = requireWorkspaceId(actor)
      const eventName = await requireEvent(workspaceId, input.eventId)
      const personName = await requirePerson(workspaceId, input.personId)
      const id = dependencies.createId('attendance')

      return dependencies.transaction(
        async ({ tx, events }) => {
          let created: AttendanceRecord

          try {
            created = await repository.insertAttendance(tx, {
              id,
              workspaceId,
              eventId: input.eventId,
              personId: input.personId,
              status: input.status,
              source: input.source,
            })
          } catch (error: unknown) {
            if (postgresErrorCode(error) === UNIQUE_VIOLATION) {
              throw duplicateAttendance()
            }

            throw error
          }

          await dependencies.recordActivity(tx, workspaceId, actor, {
            targetType: 'event',
            targetId: input.eventId,
            kind: 'linked',
            ...describeLink('person', personName),
          })
          await dependencies.recordActivity(tx, workspaceId, actor, {
            targetType: 'person',
            targetId: input.personId,
            kind: 'linked',
            ...describeLink('event', eventName),
          })

          events.emit('events.attendance.created', { type: 'attendance', id }, {})

          return toView(created)
        },
        { workspaceId, actor: toEventActor(actor) },
      )
    },

    async update(actor, id, changes) {
      const workspaceId = requireWorkspaceId(actor)
      const existing = await require(workspaceId, id)
      const columns: Partial<repository.AttendanceColumns> = {
        ...(changes.status === undefined ? {} : { status: changes.status }),
      }
      const changed = changedKeys(existing, columns)

      if (changed.length === 0) {
        return toView(existing)
      }

      return dependencies.transaction(
        async ({ tx, events }) => {
          const updated = await repository.updateAttendance(tx, workspaceId, id, {
            ...columns,
            updatedAt: dependencies.now(),
          })

          if (updated === undefined) {
            throw AppError.notFound('Attendance not found')
          }

          const before = {
            status: ATTENDANCE_STATUS_LABELS[existing.status as AttendanceStatus],
          }
          const after = {
            status:
              ATTENDANCE_STATUS_LABELS[(columns.status as AttendanceStatus | undefined) ?? existing.status as AttendanceStatus],
          }

          await dependencies.recordActivity(tx, workspaceId, actor, {
            targetType: 'attendance',
            targetId: id,
            kind: 'updated',
            ...describeUpdate(changed, ATTENDANCE_FIELD_LABELS, before, after),
          })

          events.emit('events.attendance.updated', { type: 'attendance', id }, { changed })

          return toView(updated)
        },
        { workspaceId, actor: toEventActor(actor) },
      )
    },

    async remove(actor, id) {
      const workspaceId = requireWorkspaceId(actor)
      const existing = await require(workspaceId, id)
      const eventName = await requireEvent(workspaceId, existing.eventId)
      const personName = await requirePerson(workspaceId, existing.personId)

      await dependencies.transaction(
        async ({ tx, events }) => {
          await deleteRecordsAttachedTo(tx, workspaceId, 'attendance', id)
          await repository.deleteAttendance(tx, workspaceId, id)

          await dependencies.recordActivity(tx, workspaceId, actor, {
            targetType: 'event',
            targetId: existing.eventId,
            kind: 'unlinked',
            ...describeUnlink('person', personName),
          })
          await dependencies.recordActivity(tx, workspaceId, actor, {
            targetType: 'person',
            targetId: existing.personId,
            kind: 'unlinked',
            ...describeUnlink('event', eventName),
          })

          events.emit('events.attendance.deleted', { type: 'attendance', id }, {})
        },
        { workspaceId, actor: toEventActor(actor) },
      )
    },
  }
}
