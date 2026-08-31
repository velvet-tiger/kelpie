import type { ConsentStatus, CustomFieldWireValue } from '@kelpie/schemas'

import { changedKeys } from '../../lib/changes.ts'
import { UNIQUE_VIOLATION, isReferenceViolation, postgresErrorCode } from '../../lib/database.ts'
import type { Database } from '../../lib/database.ts'
import { autoLinkPersonByEmailDomain } from '../../lib/emailDomainAutoLink.ts'
import { AppError } from '../../lib/errors.ts'
import type { IdFactory } from '../../lib/ids.ts'
import { normaliseEmail } from '../../lib/normalisation.ts'
import { mapPage, readListWindow, toPage } from '../../lib/pagination.ts'
import type { ListQueryParameters, Page } from '../../lib/pagination.ts'
import type { TransactionScope } from '../../runtime/transaction.ts'
import type { ActivityRecorder } from '../activities/recorder.ts'
import { describeCreation, describeUpdate } from '../activities/wording.ts'
import type { FieldLabels } from '../activities/wording.ts'
import { toEventActor } from '../../lib/actor.ts'
import type { Actor } from '../auth/actor.ts'
import { requireWorkspaceId } from '../auth/actor.ts'
import './events.ts'
import {
  deleteRecordsAttachedTo,
  deleteRecordsAttachedToCandidaciesOf,
} from '../attachedRecords.ts'
import type { CustomFieldValuesValidator } from '../custom-fields/values.ts'
import * as personLinks from '../personLinks.ts'
import { referenceViolationTable } from '../../lib/database.ts'
import { referencedByPipelineRecords, referencedElsewhere } from '../references.ts'
import * as repository from './repository.ts'
import { DEFAULT_PERSON_SORT, PERSON_SORTS } from './repository.ts'
import type { PersonFilters, PersonRecord } from './repository.ts'
import type { Influence, PreferredChannel, Relationship, SocialProfile } from './schema.ts'
import { readConsentsFor, readConsentsForMany } from './consentHydration.ts'
import type { EffectiveConsent } from './consentHydration.ts'
import { applyManualConsentWrites, consentChangedPaths } from './personConsentWrites.ts'

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
  readonly customFields: CustomFieldValuesValidator
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
  salutation: 'Salutation',
  firstName: 'First name',
  lastName: 'Last name',
  suffix: 'Suffix',
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
  doNotContact: 'Do not contact',
}

/**
 * A person as the API returns one: the stored row minus the tenancy column.
 *
 * Deliberately an alias rather than a parallel interface. A hand-written copy of
 * fifteen fields drifts from the table the first time one is added.
 */
export type PersonView = Omit<PersonRecord, 'workspaceId'> & {
  /**
   * The effective consent status for every workspace purpose. An entry with
   * `inherited: true` has no explicit `person_consents` row and carries the
   * purpose's `default_status`; the rest have their own row.
   */
  readonly consents: readonly EffectiveConsent[]
}

export interface PersonConsentWriteInput {
  readonly purposeSlug: string
  readonly status: ConsentStatus | null
}

export interface CreatePersonInput {
  /** Already resolved. The route composes one from the parts when the caller sent none. */
  readonly name: string
  readonly salutation: string | null
  readonly firstName: string | null
  readonly lastName: string | null
  readonly suffix: string | null
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
  readonly doNotContact: boolean
  /**
   * Consent writes for named purposes. `status: null` deletes the row and
   * inherits the purpose default; anything else upserts `source: manual`.
   * Absent purposes are left alone.
   */
  readonly consents: readonly PersonConsentWriteInput[]
  /** Wire shape merge patch (undefined for a create without any): sent keys change, null clears. */
  readonly customFields: Readonly<Record<string, CustomFieldWireValue | null>> | undefined
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

function toView(record: PersonRecord, consents: readonly EffectiveConsent[]): PersonView {
  const { workspaceId: _workspaceId, ...view } = record

  return { ...view, consents }
}

/**
 * The stored form of what the caller sent. Blank normalises to null: the email is
 * unique per workspace, so a stored `''` would make the second person without an
 * address a 409.
 */
function toStoredColumns(input: UpdatePersonInput): Partial<repository.PersonColumns> {
  return {
    ...(input.name === undefined ? {} : { name: input.name }),
    ...(input.salutation === undefined ? {} : { salutation: input.salutation }),
    ...(input.firstName === undefined ? {} : { firstName: input.firstName }),
    ...(input.lastName === undefined ? {} : { lastName: input.lastName }),
    ...(input.suffix === undefined ? {} : { suffix: input.suffix }),
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
    ...(input.doNotContact === undefined ? {} : { doNotContact: input.doNotContact }),
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
      const consentsByPerson = await readConsentsForMany(
        dependencies.db,
        workspaceId,
        rows.map((row) => row.id),
      )

      return mapPage(toPage(rows, window, (person) => person.id), (record) =>
        toView(record, consentsByPerson.get(record.id) ?? []),
      )
    },

    async get(actor, id) {
      const workspaceId = requireWorkspaceId(actor)
      const record = await require(workspaceId, id)
      const consents = await readConsentsFor(dependencies.db, workspaceId, id)
      return toView(record, consents)
    },

    async create(actor, input) {
      const workspaceId = requireWorkspaceId(actor)
      const id = dependencies.createId('person')

      return dependencies.transaction(
        async ({ tx, events }) => {
          const customFields = await dependencies.customFields.forCreate(
            tx,
            workspaceId,
            'person',
            input.customFields,
          )
          let created: PersonRecord

          try {
            created = await repository.insertPerson(tx, {
              id,
              workspaceId,
              name: input.name,
              salutation: input.salutation,
              firstName: input.firstName,
              lastName: input.lastName,
              suffix: input.suffix,
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
              doNotContact: input.doNotContact,
              customFields,
            })
          } catch (error: unknown) {
            if (postgresErrorCode(error) === UNIQUE_VIOLATION) {
              throw duplicateEmail()
            }

            throw error
          }

          if (input.consents.length > 0) {
            await applyManualConsentWrites(
              tx,
              workspaceId,
              created.id,
              input.consents,
              dependencies.now(),
            )
          }

          await dependencies.recordActivity(tx, workspaceId, actor, {
            targetType: 'person',
            targetId: created.id,
            kind: 'created',
            ...describeCreation('Person'),
          })

          events.emit('people.person.created', { type: 'person', id: created.id }, {})

          // Sync auto-link. Inside the same transaction so the response returns
          // with the Position already visible to a follow-up read; without this
          // the UI would not see the new Position until a manual refresh.
          await autoLinkPersonByEmailDomain(tx, events, workspaceId, created, {
            createId: dependencies.createId,
            now: dependencies.now,
            recordActivity: dependencies.recordActivity,
          })

          const consents = await readConsentsFor(tx, workspaceId, created.id)
          return toView(created, consents)
        },
        { workspaceId, actor: toEventActor(actor) },
      )
    },

    async update(actor, id, changes) {
      const workspaceId = requireWorkspaceId(actor)
      const existing = await require(workspaceId, id)
      const columns = toStoredColumns(changes)
      const scalarChanged = changedKeys(existing, columns)
      const consentWrites = changes.consents ?? []

      return dependencies.transaction(
        async ({ tx, events }) => {
          const cf = await dependencies.customFields.forUpdate(
            tx,
            workspaceId,
            'person',
            existing.customFields,
            changes.customFields,
          )
          const customFieldsChanged = cf !== undefined && cf.changedPaths.length > 0

          const consentChanges =
            consentWrites.length > 0
              ? await applyManualConsentWrites(
                  tx,
                  workspaceId,
                  id,
                  consentWrites,
                  dependencies.now(),
                )
              : []
          const consentPaths = consentChangedPaths(consentChanges)
          const consentActuallyChanged = consentPaths.length > 0

          // A PATCH that changes nothing is not a write. Bumping `updated_at`
          // would make the record look freshly touched to everything that sorts
          // or filters by it.
          if (
            scalarChanged.length === 0 &&
            !customFieldsChanged &&
            !consentActuallyChanged
          ) {
            const consents = await readConsentsFor(tx, workspaceId, id)
            return toView(existing, consents)
          }

          let updated: PersonRecord | undefined

          if (scalarChanged.length > 0 || customFieldsChanged) {
            try {
              updated = await repository.updatePerson(tx, workspaceId, id, {
                ...columns,
                ...(customFieldsChanged ? { customFields: cf.merged } : {}),
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
          } else {
            updated = existing
          }

          const customFieldPaths = cf?.changedPaths ?? []
          const activityChanged = [...scalarChanged, ...customFieldPaths, ...consentPaths]

          if (activityChanged.length > 0) {
            const labels: Record<string, string> = { ...PERSON_FIELD_LABELS, ...cf?.labels }
            for (const change of consentChanges) {
              labels[`consents.${change.purposeSlug}`] = `Consent · ${change.purposeLabel}`
            }
            const before: Record<string, unknown> = { ...existing, ...cf?.flatBefore }
            const after: Record<string, unknown> = { ...columns, ...cf?.flatAfter }
            for (const change of consentChanges) {
              before[`consents.${change.purposeSlug}`] = change.previousStatus ?? 'inherits'
              after[`consents.${change.purposeSlug}`] = change.status ?? 'inherits'
            }
            await dependencies.recordActivity(tx, workspaceId, actor, {
              targetType: 'person',
              targetId: id,
              kind: 'updated',
              ...describeUpdate(activityChanged, labels, before, after),
            })
          }

          events.emit(
            'people.person.updated',
            { type: 'person', id },
            { changed: activityChanged },
          )

          // Sync auto-link when the email moved. Same-transaction rationale as
          // the create path above.
          if (scalarChanged.includes('email')) {
            await autoLinkPersonByEmailDomain(tx, events, workspaceId, updated, {
              createId: dependencies.createId,
              now: dependencies.now,
              recordActivity: dependencies.recordActivity,
            })
          }

          const consents = await readConsentsFor(tx, workspaceId, id)
          return toView(updated, consents)
        },
        { workspaceId, actor: toEventActor(actor) },
      )
    },

    async remove(actor, id) {
      const workspaceId = requireWorkspaceId(actor)

      await dependencies.transaction(
        async ({ tx, events }) => {
          await require(workspaceId, id)

          // Notes, activities and decisions carry no foreign key to their target,
          // so nothing in the database removes them. Same transaction: if the
          // delete below is refused, these come back with it.
          await deleteRecordsAttachedTo(tx, workspaceId, 'person', id)

          // The candidacy rows themselves cascade, which is why their interview
          // notes have to be taken here: no hiring service sees that delete.
          await deleteRecordsAttachedToCandidaciesOf(tx, workspaceId, id)

          // A person delete failing on a foreign key aborts the enclosing
          // transaction, so the follow-up read that names the referring pipeline
          // types would run against a dead tx. Wrap only the delete in a nested
          // transaction: drizzle emits SAVEPOINT/ROLLBACK TO for it, so the
          // outer tx survives the refusal and the listLinkedTargetTypes read
          // below sees person_links.
          let deleteError: unknown = null

          try {
            await tx.transaction(async (savepoint) => {
              await repository.deletePerson(savepoint, workspaceId, id)
            })
          } catch (error: unknown) {
            deleteError = error
          }

          if (deleteError !== null) {
            if (isReferenceViolation(deleteError)) {
              if (referenceViolationTable(deleteError) === 'person_links') {
                const types = await personLinks.listLinkedTargetTypes(tx, workspaceId, id)
                throw referencedByPipelineRecords('person', types)
              }

              throw referencedElsewhere(deleteError, 'person')
            }

            throw deleteError
          }

          events.emit('people.person.deleted', { type: 'person', id }, {})
        },
        { workspaceId, actor: toEventActor(actor) },
      )
    },
  }
}
