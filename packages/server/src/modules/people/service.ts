import { changedKeys } from '../../lib/changes.ts'
import { UNIQUE_VIOLATION, isReferenceViolation, postgresErrorCode } from '../../lib/database.ts'
import type { Database } from '../../lib/database.ts'
import { AppError } from '../../lib/errors.ts'
import type { IdFactory } from '../../lib/ids.ts'
import { normaliseEmail } from '../../lib/normalisation.ts'
import { mapPage, readListWindow, toPage } from '../../lib/pagination.ts'
import type { ListQueryParameters, Page } from '../../lib/pagination.ts'
import type { TransactionScope } from '../../runtime/transaction.ts'
import type { ActivityRecorder } from '../activities/recorder.ts'
import { describeCreation, describeUpdate } from '../activities/wording.ts'
import type { FieldLabels } from '../activities/wording.ts'
import type { Actor } from '../auth/actor.ts'
import { requireWorkspaceId } from '../auth/actor.ts'
import { deleteRecordsAttachedTo } from '../attachedRecords.ts'
import { referencedElsewhere } from '../references.ts'
import * as repository from './repository.ts'
import { DEFAULT_PERSON_SORT, PERSON_SORTS } from './repository.ts'
import type { PersonFilters, PersonRecord } from './repository.ts'
import type { Influence, PreferredChannel, Relationship, SocialProfile } from './schema.ts'

/**
 * People: who the workspace knows.
 *
 * No job title here. A title belongs to the Position linking a person to a
 * company, because one person can hold titles at several.
 *
 * Every member of a workspace may read and write its people. The role ladder
 * guards workspace administration, not CRM data.
 */

export interface PeopleDependencies {
  readonly db: Database
  readonly transaction: TransactionScope
  readonly createId: IdFactory
  readonly now: () => Date
  readonly recordActivity: ActivityRecorder
}

/**
 * What a changed column is called on a timeline.
 *
 * Written out rather than derived from the column name, because the mechanical
 * answer is wrong often enough to matter: `preferredChannel` happens to give
 * "Preferred channel", and `icpFit` gives "Icp fit".
 */
const PERSON_FIELD_LABELS: FieldLabels = {
  name: 'Name',
  email: 'Email',
  phones: 'Phone numbers',
  socialProfiles: 'Social profiles',
  timezone: 'Timezone',
  location: 'Location',
  preferredChannel: 'Preferred channel',
  influence: 'Influence',
  relationship: 'Relationship',
  summary: 'Summary',
  tags: 'Tags',
  lastContactedAt: 'Last contacted',
}

/**
 * A person as the API returns one: the stored row minus the tenancy column.
 *
 * Deliberately an alias rather than a parallel interface. A hand-written copy of
 * fifteen fields drifts from the table the first time one is added.
 */
export type PersonView = Omit<PersonRecord, 'workspaceId'>

export interface CreatePersonInput {
  readonly name: string
  readonly email: string | null
  readonly phones: readonly string[]
  readonly socialProfiles: readonly SocialProfile[]
  readonly timezone: string | null
  readonly location: string | null
  readonly preferredChannel: PreferredChannel
  readonly influence: Influence
  readonly relationship: Relationship
  readonly summary: string
  readonly tags: readonly string[]
  readonly lastContactedAt: Date | null
}

/** PATCH semantics: an absent field is left alone, and null clears a nullable one. */
export type UpdatePersonInput = Partial<CreatePersonInput>

export interface PeopleService {
  list(actor: Actor, filters: PersonFilters, query: ListQueryParameters): Promise<Page<PersonView>>
  get(actor: Actor, id: string): Promise<PersonView>
  create(actor: Actor, input: CreatePersonInput): Promise<PersonView>
  update(actor: Actor, id: string, changes: UpdatePersonInput): Promise<PersonView>
  remove(actor: Actor, id: string): Promise<void>
}

function toView(record: PersonRecord): PersonView {
  const { workspaceId: _workspaceId, ...view } = record

  return view
}

/**
 * The stored form of what the caller sent. Blank normalises to null: the email is
 * unique per workspace, so a stored `''` would make the second person without an
 * address a 409.
 */
function toStoredColumns(input: UpdatePersonInput): Partial<repository.PersonColumns> {
  return {
    ...(input.name === undefined ? {} : { name: input.name }),
    ...(input.email === undefined ? {} : { email: input.email === null ? null : normaliseEmail(input.email) }),
    ...(input.phones === undefined ? {} : { phones: input.phones }),
    ...(input.socialProfiles === undefined ? {} : { socialProfiles: input.socialProfiles }),
    ...(input.timezone === undefined ? {} : { timezone: input.timezone }),
    ...(input.location === undefined ? {} : { location: input.location }),
    ...(input.preferredChannel === undefined ? {} : { preferredChannel: input.preferredChannel }),
    ...(input.influence === undefined ? {} : { influence: input.influence }),
    ...(input.relationship === undefined ? {} : { relationship: input.relationship }),
    ...(input.summary === undefined ? {} : { summary: input.summary }),
    ...(input.tags === undefined ? {} : { tags: [...input.tags] }),
    ...(input.lastContactedAt === undefined ? {} : { lastContactedAt: input.lastContactedAt }),
  }
}

function duplicateEmail(): AppError {
  return AppError.conflict('Another person in this workspace already has that email address', [
    { field: 'email', message: 'Already in use' },
  ])
}

export function createPeopleService(dependencies: PeopleDependencies): PeopleService {
  async function require(workspaceId: string, id: string): Promise<PersonRecord> {
    const person = await repository.findPerson(dependencies.db, workspaceId, id)

    // A person in another workspace is indistinguishable from one that never
    // existed, per `api.md`.
    if (person === undefined) {
      throw AppError.notFound('Person not found')
    }

    return person
  }

  return {
    async list(actor, filters, query) {
      const workspaceId = requireWorkspaceId(actor)
      const window = readListWindow(query, PERSON_SORTS, DEFAULT_PERSON_SORT)
      const rows = await repository.listPeople(dependencies.db, workspaceId, filters, window)

      return mapPage(toPage(rows, window, (person) => person.id), toView)
    },

    async get(actor, id) {
      return toView(await require(requireWorkspaceId(actor), id))
    },

    async create(actor, input) {
      const workspaceId = requireWorkspaceId(actor)
      const id = dependencies.createId('person')

      return dependencies.transaction(async ({ tx, events }) => {
        let created: PersonRecord

        try {
          created = await repository.insertPerson(tx, {
            id,
            workspaceId,
            name: input.name,
            email: input.email === null ? null : normaliseEmail(input.email),
            phones: input.phones,
            socialProfiles: input.socialProfiles,
            timezone: input.timezone,
            location: input.location,
            preferredChannel: input.preferredChannel,
            influence: input.influence,
            relationship: input.relationship,
            summary: input.summary,
            tags: [...input.tags],
            lastContactedAt: input.lastContactedAt,
          })
        } catch (error: unknown) {
          if (postgresErrorCode(error) === UNIQUE_VIOLATION) {
            throw duplicateEmail()
          }

          throw error
        }

        await dependencies.recordActivity(tx, workspaceId, actor, {
          targetType: 'person',
          targetId: created.id,
          kind: 'created',
          ...describeCreation('Person'),
        })

        events.emit('record.created', { workspaceId, objectType: 'person', recordId: created.id })

        return toView(created)
      })
    },

    async update(actor, id, changes) {
      const workspaceId = requireWorkspaceId(actor)
      const existing = await require(workspaceId, id)
      const columns = toStoredColumns(changes)
      const changed = changedKeys(existing, columns)

      // A PATCH that changes nothing is not a write. Bumping `updated_at` for it
      // would make the record look freshly touched to everything that sorts or
      // filters by it.
      if (changed.length === 0) {
        return toView(existing)
      }

      return dependencies.transaction(async ({ tx, events }) => {
        let updated: PersonRecord | undefined

        try {
          updated = await repository.updatePerson(tx, workspaceId, id, {
            ...columns,
            updatedAt: dependencies.now(),
          })
        } catch (error: unknown) {
          if (postgresErrorCode(error) === UNIQUE_VIOLATION) {
            throw duplicateEmail()
          }

          throw error
        }

        if (updated === undefined) {
          throw AppError.notFound('Person not found')
        }

        await dependencies.recordActivity(tx, workspaceId, actor, {
          targetType: 'person',
          targetId: id,
          kind: 'updated',
          ...describeUpdate(changed, PERSON_FIELD_LABELS, existing, columns),
        })

        events.emit('record.updated', {
          workspaceId,
          objectType: 'person',
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

        // Notes, activities and decisions carry no foreign key to their target,
        // so nothing in the database removes them. Same transaction: if the
        // delete below is refused, these come back with it.
        await deleteRecordsAttachedTo(tx, workspaceId, 'person', id)

        try {
          await repository.deletePerson(tx, workspaceId, id)
        } catch (error: unknown) {
          if (isReferenceViolation(error)) {
            throw referencedElsewhere(error, 'person')
          }

          throw error
        }

        events.emit('record.deleted', { workspaceId, objectType: 'person', recordId: id })
      })
    },
  }
}
