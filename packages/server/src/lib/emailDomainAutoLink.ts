import { UNIQUE_VIOLATION, postgresErrorCode } from './database.ts'
import type { IdFactory } from './ids.ts'
import { isConsumerEmailDomain } from './consumerEmailDomains.ts'
import type { BufferedEvents, Transaction } from '../runtime/transaction.ts'
import type { ActivityRecorder, SystemActor } from '../modules/activities/recorder.ts'
import { describeLink } from '../modules/activities/wording.ts'
import * as companyRepository from '../modules/companies/repository.ts'
import type { CompanyRecord } from '../modules/companies/repository.ts'
import * as peopleRepository from '../modules/people/repository.ts'
import type { PersonRecord } from '../modules/people/repository.ts'
import '../modules/positions/events.ts'
import * as positionRepository from '../modules/positions/repository.ts'

/**
 * Auto-link a Person to a workspace Company whose domain matches the person's
 * email. Runs inside the caller's transaction, so the new Position is present
 * in the response the API returns for the same request.
 *
 * Skips: no email, consumer email host (`isConsumerEmailDomain`), no Company
 * on that domain in the workspace, or a Position already linking the two. A
 * unique-key race with a concurrent linker is absorbed.
 *
 * The created Position carries an empty title. `positions.title` is `NOT NULL`,
 * and empty reads honestly as "the domain matched; no title yet".
 *
 * Split from the people service so the layering (people below positions) is
 * carried by imports only: this helper depends on both repositories, and the
 * people service depends on this helper. The `positions` module still owns the
 * event catalogue for the emitted event.
 */

/** What the timeline calls this side effect. */
const LINKER_ACTOR: SystemActor = { kind: 'system', label: 'Email domain match' }

export interface AutoLinkDependencies {
  readonly createId: IdFactory
  readonly now: () => Date
  readonly recordActivity: ActivityRecorder
}

/**
 * Considers `person` for a matching Company in `workspaceId` and inserts a
 * titleless Position if none links them yet.
 *
 * @returns The new Position's id, or `undefined` if nothing was written.
 */
export async function autoLinkPersonByEmailDomain(
  tx: Transaction,
  events: BufferedEvents,
  workspaceId: string,
  person: PersonRecord,
  dependencies: AutoLinkDependencies,
): Promise<string | undefined> {
  if (person.email === null) {
    return undefined
  }

  const at = person.email.indexOf('@')
  if (at < 0) {
    return undefined
  }

  const domain = person.email.slice(at + 1)
  if (domain.length === 0 || isConsumerEmailDomain(domain)) {
    return undefined
  }

  const company = await companyRepository.findCompanyByDomain(tx, workspaceId, domain)
  if (company === undefined) {
    return undefined
  }

  const held = await positionRepository.listPositionsAt(tx, workspaceId, person.id, company.id)
  if (held.length > 0) {
    return undefined
  }

  return insertStubPosition(tx, events, workspaceId, person, company, dependencies)
}

/**
 * Sweeps every Person in `workspaceId` whose email domain matches `company`'s
 * domain and stubs a Position where none exists yet. Called when a Company is
 * created or its domain is set.
 *
 * @returns The ids of every Position this call inserted.
 */
export async function autoLinkCompanyByDomain(
  tx: Transaction,
  events: BufferedEvents,
  workspaceId: string,
  company: CompanyRecord,
  dependencies: AutoLinkDependencies,
): Promise<readonly string[]> {
  if (company.domain === null || company.domain.length === 0) {
    return []
  }

  if (isConsumerEmailDomain(company.domain)) {
    return []
  }

  const matches = await peopleRepository.findPeopleByEmailDomain(tx, workspaceId, company.domain)
  const created: string[] = []

  for (const person of matches) {
    const held = await positionRepository.listPositionsAt(tx, workspaceId, person.id, company.id)
    if (held.length > 0) {
      continue
    }

    const id = await insertStubPosition(tx, events, workspaceId, person, company, dependencies)
    if (id !== undefined) {
      created.push(id)
    }
  }

  return created
}

/**
 * The write half. Wraps the unique-constraint race the two entry points share:
 * a concurrent linker that beat us to `(personId, companyId, '')` is treated
 * as success (the link is there, either way).
 */
async function insertStubPosition(
  tx: Transaction,
  events: BufferedEvents,
  workspaceId: string,
  person: PersonRecord,
  company: CompanyRecord,
  dependencies: AutoLinkDependencies,
): Promise<string | undefined> {
  try {
    const created = await positionRepository.insertPosition(tx, {
      id: dependencies.createId('position'),
      workspaceId,
      personId: person.id,
      companyId: company.id,
      title: '',
    })

    await dependencies.recordActivity(tx, workspaceId, LINKER_ACTOR, {
      targetType: 'person',
      targetId: person.id,
      kind: 'linked',
      ...describeLink('company', company.name),
    })
    await dependencies.recordActivity(tx, workspaceId, LINKER_ACTOR, {
      targetType: 'company',
      targetId: company.id,
      kind: 'linked',
      ...describeLink('person', person.name),
    })

    events.emit('positions.position.created', { type: 'position', id: created.id }, {})

    return created.id
  } catch (error: unknown) {
    if (postgresErrorCode(error) === UNIQUE_VIOLATION) {
      return undefined
    }
    throw error
  }
}
