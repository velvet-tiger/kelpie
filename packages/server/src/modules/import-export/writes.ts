import { changedKeys } from '../../lib/changes.ts'
import { AppError } from '../../lib/errors.ts'
import type { IdFactory } from '../../lib/ids.ts'
import type { RecordObjectType } from '../../runtime/events.ts'
import type { Transaction } from '../../runtime/transaction.ts'
import type { ActivityRecorder } from '../activities/recorder.ts'
import { describeCreationVia, describeLink, describeUpdateVia } from '../activities/wording.ts'
import type { Actor } from '../auth/actor.ts'
import * as companyRepository from '../companies/repository.ts'
import * as dealRepository from '../deals/repository.ts'
import * as peopleRepository from '../people/repository.ts'
import * as personLinks from '../personLinks.ts'
import * as positionRepository from '../positions/repository.ts'
import { IMPORT_DEAL_CURRENCY, NEW_COMPANY_DEFAULTS, NEW_PERSON_DEFAULTS } from './drafts.ts'
import type { ImportWrite, PlannedAffiliation, RowPlan } from './plan.ts'

/**
 * Applying one planned row: the insert or update, and the timeline entry that
 * says where the record came from.
 *
 * The activity is the reason this is not four lines in the service. A record an
 * import invented has to say so on its own timeline — `created Company via
 * acme-companies.csv` — and a Position says it on both ends rather than on
 * itself, because a position is a link and nothing renders its timeline.
 */

export interface WriteDependencies {
  readonly tx: Transaction
  readonly workspaceId: string
  readonly createId: IdFactory
  readonly now: Date
  readonly actor: Actor
  readonly recordActivity: ActivityRecorder
  /** What the timeline names as the source: the uploaded file. */
  readonly sourceName: string
}

/**
 * A record a row wrote besides its primary one.
 *
 * A People row with an affiliation makes a Position, and under
 * `on_missing_company: create` a Company as well. Each needs its own module
 * event, which the service emits from these.
 */
export interface SideRecord {
  readonly objectType: RecordObjectType
  readonly recordId: string
  readonly created: boolean
  /** The columns an update moved. Empty on a create. */
  readonly changedFields: readonly string[]
}

export interface WriteOutcome {
  readonly recordId: string
  readonly objectType: RecordObjectType
  /**
   * The columns an update moved, for `record.updated`. Empty on a create, and
   * empty on an update that resent the values already stored — which emits
   * nothing at all.
   */
  readonly changedFields: readonly string[]
  /** Records the row wrote besides its primary one: a People affiliation's company and position. */
  readonly sideRecords?: readonly SideRecord[]
}

/** A create or update plan. `skip` and `error` never reach here. */
type WritablePlan = Extract<RowPlan, { action: 'create' } | { action: 'update' }>

function requireTarget(plan: Extract<RowPlan, { action: 'update' }>): string {
  // A commit resolves its lookups inside its own transaction, so an update it
  // planned always names a record that exists. The in-file placeholder is a
  // dry-run artefact and cannot arrive here.
  if (plan.targetId === null) {
    throw new Error('An import commit planned an update with no record to update')
  }

  return plan.targetId
}

async function writeCompany(
  dependencies: WriteDependencies,
  plan: WritablePlan,
  write: Extract<ImportWrite, { object: 'companies' }>,
): Promise<WriteOutcome> {
  const { tx, workspaceId } = dependencies

  if (plan.action === 'create') {
    const created = await companyRepository.insertCompany(tx, {
      ...NEW_COMPANY_DEFAULTS,
      ...write.draft,
      tags: write.draft.tags === undefined ? undefined : [...write.draft.tags],
      id: dependencies.createId('company'),
      workspaceId,
      name: write.draft.name ?? '',
    })

    return { recordId: created.id, objectType: 'company', changedFields: [] }
  }

  const id = requireTarget(plan)
  const existing = await companyRepository.findCompany(tx, workspaceId, id)

  if (existing === undefined) {
    throw AppError.notFound('Company not found')
  }

  const columns = {
    ...write.draft,
    tags: write.draft.tags === undefined ? undefined : [...write.draft.tags],
  }
  const changedFields = changedKeys(existing, columns)

  if (changedFields.length > 0) {
    await companyRepository.updateCompany(tx, workspaceId, id, {
      ...columns,
      updatedAt: dependencies.now,
    })
  }

  return { recordId: id, objectType: 'company', changedFields }
}

/**
 * Writes the position a People row named, and the company it belongs to when the
 * job was told to create one.
 *
 * The company is created before the position so the link has something to point
 * at. The position is renamed in place when the person already holds one at that
 * company, and created otherwise, which is the two-column-key behaviour the
 * People affiliation chose. Files the `created Company` and `linked to company`
 * activities as it goes, the same sentences the Companies and Positions imports
 * write.
 */
async function applyAffiliation(
  dependencies: WriteDependencies,
  personId: string,
  affiliation: PlannedAffiliation,
): Promise<readonly SideRecord[]> {
  const { tx, workspaceId, actor, sourceName } = dependencies
  const sideRecords: SideRecord[] = []

  const companyId = await (async (): Promise<string> => {
    if (affiliation.kind === 'link') {
      return affiliation.companyId
    }

    const created = await companyRepository.insertCompany(tx, {
      ...NEW_COMPANY_DEFAULTS,
      ...affiliation.company,
      tags: affiliation.company.tags === undefined ? undefined : [...affiliation.company.tags],
      id: dependencies.createId('company'),
      workspaceId,
      name: affiliation.company.name ?? '',
    })

    sideRecords.push({ objectType: 'company', recordId: created.id, created: true, changedFields: [] })
    await dependencies.recordActivity(tx, workspaceId, actor, {
      targetType: 'company',
      targetId: created.id,
      kind: 'created',
      ...describeCreationVia('Company', sourceName),
    })

    return created.id
  })()

  const held = await positionRepository.listPositionsAt(tx, workspaceId, personId, companyId)
  const current = held[0]

  if (current === undefined) {
    const created = await positionRepository.insertPosition(tx, {
      id: dependencies.createId('position'),
      workspaceId,
      personId,
      companyId,
      title: affiliation.title,
    })

    sideRecords.push({ objectType: 'position', recordId: created.id, created: true, changedFields: [] })

    for (const end of [
      { targetType: 'person', targetId: personId, related: 'company' },
      { targetType: 'company', targetId: companyId, related: 'person' },
    ] as const) {
      await dependencies.recordActivity(tx, workspaceId, actor, {
        targetType: end.targetType,
        targetId: end.targetId,
        kind: 'linked',
        ...describeLink(end.related, sourceName),
      })
    }

    return sideRecords
  }

  const changedFields = changedKeys(current, { title: affiliation.title })

  if (changedFields.length > 0) {
    await positionRepository.updatePosition(tx, workspaceId, current.id, {
      title: affiliation.title,
      updatedAt: dependencies.now,
    })
    sideRecords.push({ objectType: 'position', recordId: current.id, created: false, changedFields })
  }

  return sideRecords
}

async function writePerson(
  dependencies: WriteDependencies,
  plan: WritablePlan,
  write: Extract<ImportWrite, { object: 'people' }>,
): Promise<WriteOutcome> {
  const { tx, workspaceId } = dependencies

  if (plan.action === 'create') {
    const created = await peopleRepository.insertPerson(tx, {
      ...NEW_PERSON_DEFAULTS,
      ...write.draft,
      phones: write.draft.phones === undefined ? undefined : [...write.draft.phones],
      tags: write.draft.tags === undefined ? undefined : [...write.draft.tags],
      id: dependencies.createId('person'),
      workspaceId,
      // `name` is not a required column any more; the People row check is what
      // guarantees one, from the row's own `name` or composed from its first and
      // last name cells. A row reaching here without one never passed validation.
      name: write.draft.name ?? '',
    })

    const sideRecords =
      write.affiliation === undefined
        ? []
        : await applyAffiliation(dependencies, created.id, write.affiliation)

    return { recordId: created.id, objectType: 'person', changedFields: [], sideRecords }
  }

  const id = requireTarget(plan)
  const existing = await peopleRepository.findPerson(tx, workspaceId, id)

  if (existing === undefined) {
    throw AppError.notFound('Person not found')
  }

  const columns = {
    ...write.draft,
    phones: write.draft.phones === undefined ? undefined : [...write.draft.phones],
    tags: write.draft.tags === undefined ? undefined : [...write.draft.tags],
  }
  const changedFields = changedKeys(existing, columns)

  if (changedFields.length > 0) {
    await peopleRepository.updatePerson(tx, workspaceId, id, {
      ...columns,
      updatedAt: dependencies.now,
    })
  }

  const sideRecords =
    write.affiliation === undefined
      ? []
      : await applyAffiliation(dependencies, id, write.affiliation)

  return { recordId: id, objectType: 'person', changedFields, sideRecords }
}

/**
 * A Position's only writable field is its title, so an update is a rename.
 *
 * With the three-column match key a title change is a different key and creates
 * a second position; with the two-column key it renames the one that is there,
 * which is the reason that key exists.
 */
async function writePosition(
  dependencies: WriteDependencies,
  plan: WritablePlan,
  write: Extract<ImportWrite, { object: 'positions' }>,
): Promise<WriteOutcome> {
  const { tx, workspaceId } = dependencies

  if (plan.action === 'create') {
    const created = await positionRepository.insertPosition(tx, {
      id: dependencies.createId('position'),
      workspaceId,
      personId: write.personId,
      companyId: write.companyId,
      title: write.title,
    })

    return { recordId: created.id, objectType: 'position', changedFields: [] }
  }

  const id = requireTarget(plan)
  const existing = await positionRepository.findPosition(tx, workspaceId, id)

  if (existing === undefined) {
    throw AppError.notFound('Position not found')
  }

  const changedFields = changedKeys(existing, { title: write.title })

  if (changedFields.length > 0) {
    await positionRepository.updatePosition(tx, workspaceId, id, {
      title: write.title,
      updatedAt: dependencies.now,
    })
  }

  return { recordId: id, objectType: 'position', changedFields }
}

/**
 * The people on a deal are replaced only when the file said something about
 * them.
 *
 * `person_emails` blank or unmapped leaves the existing contacts alone, the same
 * rule every other column follows. A mapped, filled-in cell is the file stating
 * the list, so it replaces.
 */
async function reconcileDealPeople(
  dependencies: WriteDependencies,
  dealId: string,
  personIds: readonly string[],
): Promise<boolean> {
  const target = { targetType: 'deal' as const, targetId: dealId }
  const current = await personLinks.listPersonIds(dependencies.tx, dependencies.workspaceId, target)
  const added = personIds.filter((personId) => !current.includes(personId))
  const removed = current.filter((personId) => !personIds.includes(personId))

  await personLinks.linkPeople(
    dependencies.tx,
    dependencies.createId,
    dependencies.workspaceId,
    target,
    added,
  )
  await personLinks.unlinkPeople(dependencies.tx, dependencies.workspaceId, target, removed)

  return added.length > 0 || removed.length > 0
}

async function writeDeal(
  dependencies: WriteDependencies,
  plan: WritablePlan,
  write: Extract<ImportWrite, { object: 'deals' }>,
): Promise<WriteOutcome> {
  const { tx, workspaceId } = dependencies

  if (plan.action === 'create') {
    const id = dependencies.createId('deal')

    await dealRepository.insertDeal(tx, {
      ...write.draft,
      competitors: write.draft.competitors === undefined ? undefined : [...write.draft.competitors],
      tags: write.draft.tags === undefined ? undefined : [...write.draft.tags],
      id,
      workspaceId,
      name: write.draft.name ?? '',
      companyId: write.companyId,
      stageId: write.stageId,
      ownerId: write.ownerId,
      // A value with no currency beside it means nothing. The deals API defaults
      // the same way, and no CSV column carries one.
      currency: IMPORT_DEAL_CURRENCY,
    })
    await personLinks.linkPeople(
      tx,
      dependencies.createId,
      workspaceId,
      { targetType: 'deal', targetId: id },
      write.personIds,
    )

    return { recordId: id, objectType: 'deal', changedFields: [] }
  }

  const id = requireTarget(plan)
  const existing = await dealRepository.findDeal(tx, workspaceId, id)

  if (existing === undefined) {
    throw AppError.notFound('Deal not found')
  }

  const columns = {
    ...write.draft,
    competitors: write.draft.competitors === undefined ? undefined : [...write.draft.competitors],
    tags: write.draft.tags === undefined ? undefined : [...write.draft.tags],
    companyId: write.companyId,
    stageId: write.stageId,
    ...(write.ownerId === null ? {} : { ownerId: write.ownerId }),
  }
  const changed = changedKeys(existing, columns)

  if (changed.length > 0) {
    await dealRepository.updateDeal(tx, workspaceId, id, {
      ...columns,
      updatedAt: dependencies.now,
    })
  }

  const peopleMoved = write.setsPeople
    ? await reconcileDealPeople(dependencies, id, write.personIds)
    : false

  return {
    recordId: id,
    objectType: 'deal',
    changedFields: peopleMoved ? [...changed, 'personIds'] : changed,
  }
}

/** What a timeline calls each object. */
const OBJECT_LABEL: Readonly<Record<ImportWrite['object'], string>> = {
  companies: 'Company',
  people: 'Person',
  positions: 'Position',
  deals: 'Deal',
}

/**
 * Files the timeline entry.
 *
 * A Position lands on the person and the company rather than on itself: nothing
 * renders a position's timeline, and `linked to company` is the sentence the
 * positions service already writes for the same event.
 */
async function recordHistory(
  dependencies: WriteDependencies,
  plan: WritablePlan,
  write: ImportWrite,
  outcome: WriteOutcome,
): Promise<void> {
  const { tx, workspaceId, actor, sourceName } = dependencies

  if (write.object === 'positions') {
    if (plan.action !== 'create') {
      return
    }

    for (const end of [
      { targetType: 'person', targetId: write.personId, related: 'company' },
      { targetType: 'company', targetId: write.companyId, related: 'person' },
    ] as const) {
      await dependencies.recordActivity(tx, workspaceId, actor, {
        targetType: end.targetType,
        targetId: end.targetId,
        kind: 'linked',
        ...describeLink(end.related, sourceName),
      })
    }

    return
  }

  // An update that moved nothing is not history. The record was matched and
  // resent, which is what a re-run of the same file does.
  if (plan.action === 'update' && outcome.changedFields.length === 0) {
    return
  }

  const label = OBJECT_LABEL[write.object]

  await dependencies.recordActivity(tx, workspaceId, actor, {
    targetType: write.object === 'companies' ? 'company' : write.object === 'people' ? 'person' : 'deal',
    targetId: outcome.recordId,
    kind: plan.action === 'create' ? 'created' : 'updated',
    ...(plan.action === 'create'
      ? describeCreationVia(label, sourceName)
      : describeUpdateVia(label, sourceName)),
  })
}

/** Applies one planned row and files its history. Runs inside the caller's transaction. */
export async function applyWrite(
  dependencies: WriteDependencies,
  plan: WritablePlan,
): Promise<WriteOutcome> {
  const { write } = plan
  const outcome = await (async (): Promise<WriteOutcome> => {
    switch (write.object) {
      case 'companies':
        return writeCompany(dependencies, plan, write)
      case 'people':
        return writePerson(dependencies, plan, write)
      case 'positions':
        return writePosition(dependencies, plan, write)
      case 'deals':
        return writeDeal(dependencies, plan, write)
    }
  })()

  await recordHistory(dependencies, plan, write, outcome)

  return outcome
}
