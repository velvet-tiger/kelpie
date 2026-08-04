import { CANDIDATE_STATUS_LABELS, INTERVIEW_STAGE_LABELS } from '@kelpie/schemas'
import type { CandidateStatus, InterviewStage } from '@kelpie/schemas'

import { changedKeys } from '../../lib/changes.ts'
import { UNIQUE_VIOLATION, postgresErrorCode } from '../../lib/database.ts'
import type { Database } from '../../lib/database.ts'
import { AppError } from '../../lib/errors.ts'
import type { IdFactory } from '../../lib/ids.ts'
import { mapPage, readListWindow, toPage } from '../../lib/pagination.ts'
import type { ListQueryParameters, Page } from '../../lib/pagination.ts'
import type { TransactionScope } from '../../runtime/transaction.ts'
import type { ActivityRecorder } from '../activities/recorder.ts'
import { describeLink, describeUnlink, describeUpdate } from '../activities/wording.ts'
import type { FieldLabels } from '../activities/wording.ts'
import type { Actor } from '../auth/actor.ts'
import { requireWorkspaceId } from '../auth/actor.ts'
import { deleteRecordsAttachedTo } from '../attachedRecords.ts'
import * as repository from './repository.ts'
import { DEFAULT_CANDIDATE_SORT, CANDIDATE_SORTS } from './repository.ts'
import type { CandidateFilters, CandidateRecord } from './repository.ts'
import { FIRST_INTERVIEW_STAGE, IN_PROCESS } from './schema.ts'

/**
 * Candidate: the Person↔Role link, and the only place hiring pipeline state
 * lives. A bare set of hiring fields on Person would force one pipeline per
 * person, which is wrong for anyone considered for two roles.
 *
 * A candidacy has no timeline of its own that anything reads. What happens to it
 * is filed on the **person's** timeline, which is where the mockup's own seeded
 * hiring activity sits (`targetType: "person"` in `mockups/src/data/seed.ts`)
 * and the only page that shows it. Notes are the other way round: an interview
 * note is about this candidacy, not about the person in general, so it attaches
 * here.
 */

export interface CandidatesDependencies {
  readonly db: Database
  readonly transaction: TransactionScope
  readonly createId: IdFactory
  readonly now: () => Date
  readonly recordActivity: ActivityRecorder
}

/** What a changed column is called on a timeline. */
const CANDIDATE_FIELD_LABELS: FieldLabels = {
  status: 'Candidate status',
  interviewStage: 'Interview stage',
  referrerPersonId: 'Referrer',
}

/** A candidate as the API returns one: the stored row minus the tenancy column. */
export type CandidateView = Omit<CandidateRecord, 'workspaceId'>

export interface CreateCandidateInput {
  readonly roleId: string
  readonly personId: string
  /** Absent means in process, where the mockup's "Add candidate" starts one. */
  readonly status: CandidateStatus
  /** Absent means the first stage while in process, and nothing otherwise. */
  readonly interviewStage: InterviewStage | null | undefined
  readonly referrerPersonId: string | null
}

/**
 * PATCH semantics: an absent field is left alone, and null clears a nullable one.
 *
 * Neither end is here. Repointing a candidacy at a different person or role is a
 * delete and a create, the rule Position already follows.
 */
export interface UpdateCandidateInput {
  readonly status?: CandidateStatus | undefined
  readonly interviewStage?: InterviewStage | null | undefined
  readonly referrerPersonId?: string | null | undefined
}

export interface CandidatesService {
  list(
    actor: Actor,
    filters: CandidateFilters,
    query: ListQueryParameters,
  ): Promise<Page<CandidateView>>
  get(actor: Actor, id: string): Promise<CandidateView>
  create(actor: Actor, input: CreateCandidateInput): Promise<CandidateView>
  update(actor: Actor, id: string, changes: UpdateCandidateInput): Promise<CandidateView>
  remove(actor: Actor, id: string): Promise<void>
}

function toView(record: CandidateRecord): CandidateView {
  const { workspaceId: _workspaceId, ...view } = record

  return view
}

function duplicateCandidacy(): AppError {
  return AppError.conflict('That person is already a candidate for that role', [
    { field: 'person_id', message: 'Already a candidate for this role' },
  ])
}

/**
 * The interview stage a candidacy carries once a write lands, mirroring the
 * mockup's `candidatePatchForStatus`.
 *
 * Leaving `in_process` clears the stage. That is normalisation of a dependent
 * column rather than a caller's value being dropped: a stage on a passed
 * candidate would claim they are still being interviewed. A caller who names a
 * stage that contradicts the status is refused instead, in `requireStageFits`.
 *
 * Pure and exported so the rule can be read and tested without a database.
 */
export function interviewStageAfter(
  status: CandidateStatus,
  requested: InterviewStage | null | undefined,
  current: InterviewStage | null,
): InterviewStage | null {
  if (status !== IN_PROCESS) {
    return null
  }

  return requested ?? current ?? FIRST_INTERVIEW_STAGE
}

/**
 * @throws AppError 422 when the stage and the status cannot both be true. An
 *   unknown enum is a 422 at the boundary per `api.md`, and so is a known one
 *   that contradicts the record it is being written to.
 */
function requireStageFits(
  status: CandidateStatus,
  requested: InterviewStage | null | undefined,
): void {
  if (requested === undefined) {
    return
  }

  if (status !== IN_PROCESS && requested !== null) {
    throw AppError.validationFailed('Only a candidate in process has an interview stage', [
      { field: 'interview_stage', message: `Not while the status is ${status}` },
    ])
  }

  if (status === IN_PROCESS && requested === null) {
    throw AppError.validationFailed('A candidate in process is always at some stage', [
      { field: 'interview_stage', message: 'Expected a stage' },
    ])
  }
}

/**
 * The values a timeline prints, from the values a column stores.
 *
 * `describeUpdate` renders `old → new` out of whatever it is handed, and a raw
 * enum slug or a person id there reads as noise. This is the one place that
 * turns them into what the mockup writes: "In process → Nurture", not
 * "in_process → nurture".
 */
function readable(
  columns: Partial<repository.CandidateColumns>,
  names: ReadonlyMap<string, string>,
): Record<string, unknown> {
  const referrerId = columns.referrerPersonId

  return {
    ...(columns.status === undefined
      ? {}
      : { status: CANDIDATE_STATUS_LABELS[columns.status as CandidateStatus] ?? columns.status }),
    ...(columns.interviewStage === undefined
      ? {}
      : {
          interviewStage:
            columns.interviewStage === null
              ? null
              : (INTERVIEW_STAGE_LABELS[columns.interviewStage as InterviewStage] ??
                columns.interviewStage),
        }),
    ...(referrerId === undefined
      ? {}
      : { referrerPersonId: referrerId === null ? null : (names.get(referrerId) ?? referrerId) }),
  }
}

export function createCandidatesService(dependencies: CandidatesDependencies): CandidatesService {
  async function require(workspaceId: string, id: string): Promise<CandidateRecord> {
    const candidate = await repository.findCandidate(dependencies.db, workspaceId, id)

    if (candidate === undefined) {
      throw AppError.notFound('Candidate not found')
    }

    return candidate
  }

  async function requireRole(workspaceId: string, roleId: string): Promise<string> {
    const role = await repository.findRole(dependencies.db, workspaceId, roleId)

    if (role === undefined) {
      throw AppError.notFound('Role not found')
    }

    return role.title
  }

  /**
   * Every named person must be in the caller's workspace. The foreign keys are
   * global, so this is what makes the tenancy boundary hold, and a person on the
   * far side of it reports as missing rather than as forbidden, per `api.md`.
   *
   * @returns Their names, for the timeline rows that name them.
   */
  async function requirePeople(
    workspaceId: string,
    personIds: readonly string[],
  ): Promise<ReadonlyMap<string, string>> {
    const wanted = [...new Set(personIds)]
    const named = await repository.findPeopleNamed(dependencies.db, workspaceId, wanted)
    const missing = wanted.filter((id) => !named.has(id))

    if (missing.length > 0) {
      throw AppError.notFound('Person not found')
    }

    return named
  }

  /** A referral is one person vouching for another, so it cannot point back at the candidate. */
  function requireReferrerIsSomeoneElse(personId: string, referrerPersonId: string | null): void {
    if (referrerPersonId === personId) {
      throw AppError.validationFailed('A candidate cannot be their own referrer', [
        { field: 'referrer_person_id', message: 'Expected a different person' },
      ])
    }
  }

  return {
    async list(actor, filters, query) {
      const workspaceId = requireWorkspaceId(actor)
      const window = readListWindow(query, CANDIDATE_SORTS, DEFAULT_CANDIDATE_SORT)
      const rows = await repository.listCandidates(dependencies.db, workspaceId, filters, window)

      return mapPage(toPage(rows, window, (candidate) => candidate.id), toView)
    },

    async get(actor, id) {
      return toView(await require(requireWorkspaceId(actor), id))
    },

    async create(actor, input) {
      const workspaceId = requireWorkspaceId(actor)

      requireStageFits(input.status, input.interviewStage)
      requireReferrerIsSomeoneElse(input.personId, input.referrerPersonId)

      const roleTitle = await requireRole(workspaceId, input.roleId)

      await requirePeople(
        workspaceId,
        input.referrerPersonId === null ? [input.personId] : [input.personId, input.referrerPersonId],
      )

      const id = dependencies.createId('candidate')

      return dependencies.transaction(async ({ tx, events }) => {
        let created: CandidateRecord

        try {
          created = await repository.insertCandidate(tx, {
            id,
            workspaceId,
            roleId: input.roleId,
            personId: input.personId,
            status: input.status,
            interviewStage: interviewStageAfter(input.status, input.interviewStage, null),
            referrerPersonId: input.referrerPersonId,
          })
        } catch (error: unknown) {
          if (postgresErrorCode(error) === UNIQUE_VIOLATION) {
            throw duplicateCandidacy()
          }

          throw error
        }

        await dependencies.recordActivity(tx, workspaceId, actor, {
          targetType: 'person',
          targetId: input.personId,
          kind: 'linked',
          ...describeLink('role', roleTitle),
        })

        events.emit('record.created', { workspaceId, objectType: 'candidate', recordId: id })

        return toView(created)
      })
    },

    async update(actor, id, changes) {
      const workspaceId = requireWorkspaceId(actor)
      const existing = await require(workspaceId, id)
      const status = changes.status ?? (existing.status as CandidateStatus)

      requireStageFits(status, changes.interviewStage)

      if (changes.referrerPersonId !== undefined) {
        requireReferrerIsSomeoneElse(existing.personId, changes.referrerPersonId)
      }

      // Both sides of a referrer change, so the timeline can name whoever is
      // leaving the field as well as whoever is arriving in it.
      const named = await requirePeople(
        workspaceId,
        [changes.referrerPersonId, existing.referrerPersonId].filter(
          (personId): personId is string => typeof personId === 'string',
        ),
      )

      const columns: Partial<repository.CandidateColumns> = {
        ...(changes.status === undefined ? {} : { status: changes.status }),
        // Always recomputed: a status leaving `in_process` clears the stage even
        // when the request said nothing about it.
        interviewStage: interviewStageAfter(
          status,
          changes.interviewStage,
          existing.interviewStage as InterviewStage | null,
        ),
        ...(changes.referrerPersonId === undefined
          ? {}
          : { referrerPersonId: changes.referrerPersonId }),
      }
      const changed = changedKeys(existing, columns)

      if (changed.length === 0) {
        return toView(existing)
      }

      return dependencies.transaction(async ({ tx, events }) => {
        const updated = await repository.updateCandidate(tx, workspaceId, id, {
          ...columns,
          updatedAt: dependencies.now(),
        })

        if (updated === undefined) {
          throw AppError.notFound('Candidate not found')
        }

        await dependencies.recordActivity(tx, workspaceId, actor, {
          targetType: 'person',
          targetId: existing.personId,
          kind: 'updated',
          ...describeUpdate(
            changed,
            CANDIDATE_FIELD_LABELS,
            readable(existing, named),
            readable(columns, named),
          ),
        })

        events.emit('record.updated', {
          workspaceId,
          objectType: 'candidate',
          recordId: id,
          changedFields: changed,
        })

        return toView(updated)
      })
    },

    async remove(actor, id) {
      const workspaceId = requireWorkspaceId(actor)

      await dependencies.transaction(async ({ tx, events }) => {
        const candidate = await require(workspaceId, id)
        const roleTitle = await requireRole(workspaceId, candidate.roleId)

        // Interview notes and their `note_added` rows carry no foreign key to
        // the candidacy, so nothing in the database removes them.
        await deleteRecordsAttachedTo(tx, workspaceId, 'candidate', id)
        await repository.deleteCandidate(tx, workspaceId, id)

        await dependencies.recordActivity(tx, workspaceId, actor, {
          targetType: 'person',
          targetId: candidate.personId,
          kind: 'unlinked',
          ...describeUnlink('role', roleTitle),
        })

        events.emit('record.deleted', { workspaceId, objectType: 'candidate', recordId: id })
      })
    },
  }
}
