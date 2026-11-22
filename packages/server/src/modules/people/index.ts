import type { EventActor } from '@kelpie/schemas'
import { composeName } from '@kelpie/schemas'

import { UNIQUE_VIOLATION, postgresErrorCode } from '../../lib/database.ts'
import type { Database } from '../../lib/database.ts'
import { autoLinkPersonByEmailDomain } from '../../lib/emailDomainAutoLink.ts'
import { AppError } from '../../lib/errors.ts'
import { MAX_SHORT_TEXT_LENGTH } from '../../lib/fieldLimits.ts'
import type { IdFactory } from '../../lib/ids.ts'
import { normaliseEmail } from '../../lib/normalisation.ts'
import { limitFor } from '../../runtime/entitlements.ts'
import type { EntitlementRegistry } from '../../runtime/entitlements.ts'
import type { KelpieModule } from '../../runtime/module.ts'
import type { Transaction, TransactionScope } from '../../runtime/transaction.ts'
import { createActivityRecorder } from '../activities/index.ts'
import { describeCreation } from '../activities/wording.ts'
import { RECORDS_LIMIT } from '../workspace/capabilities.ts'
import { countRecordsInUse } from '../workspace/repository.ts'
import { createCustomFieldValues } from '../custom-fields/index.ts'
import { peopleEvents } from './events.ts'
import * as repository from './repository.ts'
import type { PersonRecord } from './repository.ts'
import { mountPeopleRoutes } from './routes.ts'
import * as schema from './schema.ts'
import { createPeopleService } from './service.ts'
import { registerPeopleTools } from './tools.ts'

/**
 * People: who the workspace knows.
 *
 * Requires `workspace`: every person belongs to one, and the actor's workspace is
 * the only scope a request can reach.
 */
export function createPeopleModule(migrationsDirectory: string): KelpieModule {
  return {
    id: 'people',
    requires: ['workspace', 'activities', 'custom-fields'],
    structural: true,
    events: peopleEvents,

    register(context) {
      const service = createPeopleService({
        db: context.db,
        transaction: context.transaction,
        createId: context.createId,
        now: context.now,
        recordActivity: createActivityRecorder({
          createId: context.createId,
          now: context.now,
        }),
        customFields: createCustomFieldValues({ db: context.db }),
        entitlements: context.entitlements,
      })

      context.schema(schema, migrationsDirectory)

      context.routes((router) => {
        mountPeopleRoutes(router, { db: context.db, now: context.now, service })
      })

      registerPeopleTools(context.mcp, service)

      return Promise.resolve()
    },
  }
}

/** Dependencies a caller outside the people module already holds. */
export interface FindOrCreatePersonByEmailDependencies {
  readonly db: Database
  readonly transaction: TransactionScope
  readonly createId: IdFactory
  readonly now: () => Date
  /**
   * Checked for the records limit, the same as `POST /v1/people`. Pass the
   * module's `context.entitlements`. A registry of its own would answer with
   * the open-source default and skip the plan's limit.
   */
  readonly entitlements: EntitlementRegistry
}

export interface FindOrCreatePersonByEmailInput {
  readonly workspaceId: string
  /** Normalised with `normaliseEmail`, as the people create path does. */
  readonly email: string
  /** Trimmed. Blank or whitespace-only is stored as null. */
  readonly firstName?: string | null | undefined
  /** Trimmed. Blank or whitespace-only is stored as null. */
  readonly lastName?: string | null | undefined
  /**
   * The event actor to stamp on `people.person.created`. The calling module's
   * own identity, usually `{ kind: 'system' }`. Never a value read from the
   * external system's data.
   */
  readonly actor: EventActor
  /**
   * What the timeline prints as the author of the `created` activity, for
   * example `Resend`. An integration has no workspace member to attribute the
   * row to, so it names itself the way a form submit names itself `Form`.
   * A constant of the calling module. Never a value read from external data.
   */
  readonly source: string
}

export interface FindOrCreatePersonByEmailResult {
  readonly person: PersonRecord
  /** `true` when this call inserted the person. */
  readonly created: boolean
}

/** The input after the same checks `POST /v1/people` applies to its body. */
interface CheckedPersonInput {
  readonly email: string
  readonly firstName: string | null
  readonly lastName: string | null
}

function tooLong(field: string): AppError {
  return AppError.validationFailed(`${field} is too long`, [
    { field, message: `At most ${String(MAX_SHORT_TEXT_LENGTH)} characters` },
  ])
}

/** Trimmed, with blank meaning absent. */
function namePart(raw: string | null | undefined, field: string): string | null {
  if (raw === null || raw === undefined) {
    return null
  }

  if (raw.length > MAX_SHORT_TEXT_LENGTH) {
    throw tooLong(field)
  }

  const trimmed = raw.trim()

  return trimmed.length === 0 ? null : trimmed
}

/**
 * Applies the route's limits at this boundary. The caller passes data from an
 * external system, so nothing upstream has validated it.
 */
function checkPersonInput(input: FindOrCreatePersonByEmailInput): CheckedPersonInput {
  if (input.email.length > MAX_SHORT_TEXT_LENGTH) {
    throw tooLong('email')
  }

  const email = normaliseEmail(input.email)

  if (email === null) {
    throw AppError.validationFailed('An email address is required', [
      { field: 'email', message: 'Blank' },
    ])
  }

  return {
    email,
    firstName: namePart(input.firstName, 'first_name'),
    lastName: namePart(input.lastName, 'last_name'),
  }
}

/**
 * Finds the person with this email in the workspace, or creates one.
 *
 * For an integration pulling contacts in from an external system (a Resend
 * segment, for example) with no signed-in user. It reads and writes in one
 * function, which the project otherwise avoids: here the lookup and the insert
 * must share a transaction, or two syncs racing on one address would both
 * miss and both insert.
 *
 * A match is returned unchanged. An email address is a claim anybody can make,
 * so it gives the external system no right to edit the person the workspace
 * already has (the rule form submits follow). For the same reason the caller
 * must treat a match as an unverified claim: it says the external contact uses
 * this address, not that it is this person.
 *
 * A new person is created as `POST /v1/people` creates one: the same length
 * limits, the records limit, `name` composed from the first and last name
 * (falling back to the email when neither carries anything, because a blank
 * name is a record nobody can pick out), the route's defaults, a `created`
 * activity, `people.person.created` with the same payload, and the
 * email-domain auto-linker. The auto-linker runs on the claimed address too,
 * so a new person whose domain matches a company gets a Position at it.
 *
 * @throws AppError `validation_failed` when the email is blank or a field is
 *   over `MAX_SHORT_TEXT_LENGTH`, and `entitlement_required` when the
 *   workspace is at its records limit.
 */
export async function findOrCreatePersonByEmail(
  dependencies: FindOrCreatePersonByEmailDependencies,
  input: FindOrCreatePersonByEmailInput,
): Promise<FindOrCreatePersonByEmailResult> {
  const checked = checkPersonInput(input)

  try {
    return await findOrInsertPerson(dependencies, input, checked)
  } catch (error: unknown) {
    if (postgresErrorCode(error) !== UNIQUE_VIOLATION) {
      throw error
    }

    // Another writer inserted this address between the lookup and the insert.
    // The violation aborted that transaction, so read the winner outside it.
    const winner = await repository.findPersonByEmail(
      dependencies.db,
      input.workspaceId,
      checked.email,
    )

    if (winner === undefined) {
      throw error
    }

    return { person: winner, created: false }
  }
}

/** Refuses a create that would take the workspace past its records limit. */
async function requireRecordHeadroom(
  tx: Transaction,
  entitlements: EntitlementRegistry,
  workspaceId: string,
): Promise<void> {
  const limit = await limitFor(entitlements, workspaceId, RECORDS_LIMIT.name)

  if (limit !== null && (await countRecordsInUse(tx, workspaceId)) >= limit) {
    throw new AppError(
      'entitlement_required',
      `Your plan allows ${String(limit)} record${limit === 1 ? '' : 's'} (people plus companies)`,
    )
  }
}

async function findOrInsertPerson(
  dependencies: FindOrCreatePersonByEmailDependencies,
  input: FindOrCreatePersonByEmailInput,
  checked: CheckedPersonInput,
): Promise<FindOrCreatePersonByEmailResult> {
  return dependencies.transaction(
    async ({ tx, events }) => {
      const existing = await repository.findPersonByEmail(tx, input.workspaceId, checked.email)

      if (existing !== undefined) {
        return { person: existing, created: false }
      }

      await requireRecordHeadroom(tx, dependencies.entitlements, input.workspaceId)

      const composed = composeName({ firstName: checked.firstName, lastName: checked.lastName })
      const recordActivity = createActivityRecorder({
        createId: dependencies.createId,
        now: dependencies.now,
      })

      const person = await repository.insertPerson(tx, {
        id: dependencies.createId('person'),
        workspaceId: input.workspaceId,
        name: composed.length > 0 ? composed : checked.email,
        firstName: checked.firstName,
        lastName: checked.lastName,
        email: checked.email,
        preferredChannel: 'email',
        influence: 'influencer',
        relationship: 'cold',
      })

      await recordActivity(tx, input.workspaceId, { kind: 'system', label: input.source }, {
        targetType: 'person',
        targetId: person.id,
        kind: 'created',
        ...describeCreation('Person'),
      })

      events.emit('people.person.created', { type: 'person', id: person.id }, {})

      await autoLinkPersonByEmailDomain(tx, events, input.workspaceId, person, {
        createId: dependencies.createId,
        now: dependencies.now,
        recordActivity,
      })

      return { person, created: true }
    },
    { workspaceId: input.workspaceId, actor: input.actor },
  )
}
