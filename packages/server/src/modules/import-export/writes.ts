import { changedKeys } from '../../lib/changes.ts'
import { AppError } from '../../lib/errors.ts'
import type { IdFactory } from '../../lib/ids.ts'
import type { CustomFieldValue, CustomFieldWireValue, PipelineKind } from '@kelpie/schemas'
import type { RecordObjectType } from '../../runtime/events.ts'
import type { Transaction } from '../../runtime/transaction.ts'
import type { ActivityRecorder } from '../activities/recorder.ts'
import { describeCreationVia, describeLink, describeUpdateVia } from '../activities/wording.ts'
import type { Actor } from '../auth/actor.ts'
import * as companyRepository from '../companies/repository.ts'
import * as consentPurposesRepository from '../consent-purposes/repository.ts'
import * as customFieldRepository from '../custom-fields/repository.ts'
import { createCustomFieldValues } from '../custom-fields/values.ts'
import type { CustomFieldObjectType } from '../custom-fields/schema.ts'
import * as dealRepository from '../deals/repository.ts'
import * as enquiryRepository from '../enquiries/repository.ts'
import * as opportunityRepository from '../opportunities/repository.ts'
import * as partnershipRepository from '../partnerships/repository.ts'
import * as peopleRepository from '../people/repository.ts'
import { upsertPersonConsent } from '../people/personConsentWrites.ts'
import * as personLinks from '../personLinks.ts'
import * as positionRepository from '../positions/repository.ts'
import * as raiseRepository from '../raises/repository.ts'
import { IMPORT_DEAL_CURRENCY, NEW_COMPANY_DEFAULTS, NEW_PERSON_DEFAULTS } from './drafts.ts'
import type { ImportConsentGrant, ImportWrite, PlannedAffiliation, RowPlan } from './plan.ts'

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

export type ImportWrittenObjectType = RecordObjectType | 'custom_field'

export interface WriteOutcome {
  readonly recordId: string
  readonly objectType: ImportWrittenObjectType
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

async function validatedCustomFieldsForCreate(
  tx: Transaction,
  workspaceId: string,
  objectType: CustomFieldObjectType,
  sent: Readonly<Record<string, CustomFieldWireValue>> | undefined,
): Promise<Readonly<Record<string, CustomFieldValue>> | undefined> {
  if (sent === undefined || Object.keys(sent).length === 0) {
    return undefined
  }

  return createCustomFieldValues({ db: tx }).forCreate(tx, workspaceId, objectType, sent)
}

async function validatedCustomFieldsForUpdate(
  tx: Transaction,
  workspaceId: string,
  objectType: CustomFieldObjectType,
  stored: Readonly<Record<string, CustomFieldValue>>,
  sent: Readonly<Record<string, CustomFieldWireValue>> | undefined,
): Promise<
  | {
      readonly merged: Readonly<Record<string, CustomFieldValue>>
      readonly changedPaths: readonly string[]
    }
  | undefined
> {
  if (sent === undefined || Object.keys(sent).length === 0) {
    return undefined
  }

  const merge = await createCustomFieldValues({ db: tx }).forUpdate(
    tx,
    workspaceId,
    objectType,
    stored,
    sent,
  )

  if (merge === undefined) {
    return undefined
  }

  return { merged: merge.merged, changedPaths: merge.changedPaths }
}

async function writeCompany(
  dependencies: WriteDependencies,
  plan: WritablePlan,
  write: Extract<ImportWrite, { object: 'companies' }>,
): Promise<WriteOutcome> {
  const { tx, workspaceId } = dependencies

  if (plan.action === 'create') {
    const customFields = await validatedCustomFieldsForCreate(
      tx,
      workspaceId,
      'company',
      write.draft.customFields,
    )
    const { customFields: _draftCustomFields, tags, ...rest } = write.draft
    const created = await companyRepository.insertCompany(tx, {
      ...NEW_COMPANY_DEFAULTS,
      ...rest,
      tags: tags === undefined ? undefined : [...tags],
      ...(customFields === undefined ? {} : { customFields }),
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

  const { customFields: draftCustomFields, tags, ...rest } = write.draft
  const customMerge = await validatedCustomFieldsForUpdate(
    tx,
    workspaceId,
    'company',
    existing.customFields,
    draftCustomFields,
  )
  const columns = {
    ...rest,
    tags: tags === undefined ? undefined : [...tags],
    ...(customMerge === undefined ? {} : { customFields: customMerge.merged }),
  }
  const changedFields = [
    ...changedKeys(existing, columns),
    ...(customMerge?.changedPaths ?? []),
  ]

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

    const { customFields: _customFields, tags, ...companyRest } = affiliation.company
    const created = await companyRepository.insertCompany(tx, {
      ...NEW_COMPANY_DEFAULTS,
      ...companyRest,
      tags: tags === undefined ? undefined : [...tags],
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
    const customFields = await validatedCustomFieldsForCreate(
      tx,
      workspaceId,
      'person',
      write.draft.customFields,
    )
    const { customFields: _draftCustomFields, phones, tags, ...rest } = write.draft
    const created = await peopleRepository.insertPerson(tx, {
      ...NEW_PERSON_DEFAULTS,
      ...rest,
      phones: phones === undefined ? undefined : [...phones],
      tags: tags === undefined ? undefined : [...tags],
      ...(customFields === undefined ? {} : { customFields }),
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

    if (write.consent !== undefined) {
      await applyImportConsent(dependencies, created.id, write.consent)
    }

    return { recordId: created.id, objectType: 'person', changedFields: [], sideRecords }
  }

  const id = requireTarget(plan)
  const existing = await peopleRepository.findPerson(tx, workspaceId, id)

  if (existing === undefined) {
    throw AppError.notFound('Person not found')
  }

  const { customFields: draftCustomFields, phones, tags, ...rest } = write.draft
  const customMerge = await validatedCustomFieldsForUpdate(
    tx,
    workspaceId,
    'person',
    existing.customFields,
    draftCustomFields,
  )
  const columns = {
    ...rest,
    phones: phones === undefined ? undefined : [...phones],
    tags: tags === undefined ? undefined : [...tags],
    ...(customMerge === undefined ? {} : { customFields: customMerge.merged }),
  }
  const changedFields = [
    ...changedKeys(existing, columns),
    ...(customMerge?.changedPaths ?? []),
  ]

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

  if (write.consent !== undefined) {
    await applyImportConsent(dependencies, id, write.consent)
  }

  return { recordId: id, objectType: 'person', changedFields, sideRecords }
}

/**
 * Applies the row's consent grant against the job's purpose. The purpose is
 * looked up once per call rather than cached across rows — a commit runs one
 * transaction and one row at a time — so the round trip is small and stays
 * consistent with the current transaction's view.
 */
async function applyImportConsent(
  dependencies: WriteDependencies,
  personId: string,
  consent: ImportConsentGrant,
): Promise<void> {
  const [purpose] = await consentPurposesRepository.listPurposesByIds(
    dependencies.tx,
    dependencies.workspaceId,
    [consent.purposeId],
  )
  if (purpose === undefined) return
  const notedAt = consent.notedAt === null ? dependencies.now : new Date(`${consent.notedAt}T00:00:00Z`)
  await upsertPersonConsent(
    dependencies.tx,
    dependencies.workspaceId,
    personId,
    consent.purposeId,
    purpose.slug,
    purpose.label,
    consent.status,
    'import',
    notedAt,
  )
  await dependencies.recordActivity(dependencies.tx, dependencies.workspaceId, dependencies.actor, {
    targetType: 'person',
    targetId: personId,
    kind: 'updated',
    action: `${consent.status === 'granted' ? 'granted' : 'withdrew'} ${purpose.label} consent via ${dependencies.sourceName}`,
    detail: null,
  })
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
async function reconcileLinkedPeople(
  dependencies: WriteDependencies,
  targetType: PipelineKind,
  targetId: string,
  personIds: readonly string[],
): Promise<boolean> {
  const target = { targetType, targetId }
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
    const customFields = await validatedCustomFieldsForCreate(
      tx,
      workspaceId,
      'deal',
      write.draft.customFields,
    )

    const {
      customFields: _draftCustomFields,
      competitors,
      tags,
      ...rest
    } = write.draft

    await dealRepository.insertDeal(tx, {
      ...rest,
      competitors: competitors === undefined ? undefined : [...competitors],
      tags: tags === undefined ? undefined : [...tags],
      ...(customFields === undefined ? {} : { customFields }),
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

  const {
    customFields: draftCustomFields,
    competitors,
    tags,
    ...rest
  } = write.draft
  const customMerge = await validatedCustomFieldsForUpdate(
    tx,
    workspaceId,
    'deal',
    existing.customFields,
    draftCustomFields,
  )
  const columns = {
    ...rest,
    competitors: competitors === undefined ? undefined : [...competitors],
    tags: tags === undefined ? undefined : [...tags],
    companyId: write.companyId,
    stageId: write.stageId,
    ...(write.ownerId === null ? {} : { ownerId: write.ownerId }),
    ...(customMerge === undefined ? {} : { customFields: customMerge.merged }),
  }
  const changed = [...changedKeys(existing, columns), ...(customMerge?.changedPaths ?? [])]

  if (changed.length > 0) {
    await dealRepository.updateDeal(tx, workspaceId, id, {
      ...columns,
      updatedAt: dependencies.now,
    })
  }

  const peopleMoved = write.setsPeople
    ? await reconcileLinkedPeople(dependencies, 'deal', id, write.personIds)
    : false

  return {
    recordId: id,
    objectType: 'deal',
    changedFields: peopleMoved ? [...changed, 'personIds'] : changed,
  }
}

async function writeOpportunity(
  dependencies: WriteDependencies,
  plan: WritablePlan,
  write: Extract<ImportWrite, { object: 'opportunities' }>,
): Promise<WriteOutcome> {
  const { tx, workspaceId } = dependencies

  if (plan.action === 'create') {
    const id = dependencies.createId('opportunity')
    const customFields = await validatedCustomFieldsForCreate(
      tx,
      workspaceId,
      'opportunity',
      write.draft.customFields,
    )

    const { customFields: _draftCustomFields, tags, ...rest } = write.draft

    await opportunityRepository.insertOpportunity(tx, {
      ...rest,
      tags: tags === undefined ? undefined : [...tags],
      ...(customFields === undefined ? {} : { customFields }),
      id,
      workspaceId,
      name: write.draft.name ?? '',
      kind: write.draft.kind ?? '',
      stageId: write.stageId,
      companyId: write.companyId,
      ownerId: write.ownerId,
    })
    await personLinks.linkPeople(tx, dependencies.createId, workspaceId, { targetType: 'opportunity', targetId: id }, write.personIds)

    return { recordId: id, objectType: 'opportunity', changedFields: [] }
  }

  const id = requireTarget(plan)
  const existing = await opportunityRepository.findOpportunity(tx, workspaceId, id)

  if (existing === undefined) {
    throw AppError.notFound('Opportunity not found')
  }

  const { customFields: draftCustomFields, tags, ...rest } = write.draft
  const customMerge = await validatedCustomFieldsForUpdate(
    tx,
    workspaceId,
    'opportunity',
    existing.customFields,
    draftCustomFields,
  )
  const columns = {
    ...rest,
    tags: tags === undefined ? undefined : [...tags],
    stageId: write.stageId,
    companyId: write.companyId,
    ...(write.ownerId === null ? {} : { ownerId: write.ownerId }),
    ...(customMerge === undefined ? {} : { customFields: customMerge.merged }),
  }
  const changed = [...changedKeys(existing, columns), ...(customMerge?.changedPaths ?? [])]

  if (changed.length > 0) {
    await opportunityRepository.updateOpportunity(tx, workspaceId, id, {
      ...columns,
      updatedAt: dependencies.now,
    })
  }

  const peopleMoved = write.setsPeople
    ? await reconcileLinkedPeople(dependencies, 'opportunity', id, write.personIds)
    : false

  return {
    recordId: id,
    objectType: 'opportunity',
    changedFields: peopleMoved ? [...changed, 'personIds'] : changed,
  }
}

async function writeEnquiry(
  dependencies: WriteDependencies,
  plan: WritablePlan,
  write: Extract<ImportWrite, { object: 'enquiries' }>,
): Promise<WriteOutcome> {
  const { tx, workspaceId } = dependencies

  if (plan.action === 'create') {
    const id = dependencies.createId('enquiry')
    const customFields = await validatedCustomFieldsForCreate(
      tx,
      workspaceId,
      'enquiry',
      write.draft.customFields,
    )

    const { customFields: _draftCustomFields, tags, ...rest } = write.draft

    await enquiryRepository.insertEnquiry(tx, {
      ...rest,
      tags: tags === undefined ? undefined : [...tags],
      ...(customFields === undefined ? {} : { customFields }),
      id,
      workspaceId,
      name: write.draft.name ?? '',
      source: write.draft.source ?? '',
      stageId: write.stageId,
      companyId: write.companyId,
      ownerId: write.ownerId,
    })
    await personLinks.linkPeople(tx, dependencies.createId, workspaceId, { targetType: 'enquiry', targetId: id }, write.personIds)

    return { recordId: id, objectType: 'enquiry', changedFields: [] }
  }

  const id = requireTarget(plan)
  const existing = await enquiryRepository.findEnquiry(tx, workspaceId, id)

  if (existing === undefined) {
    throw AppError.notFound('Enquiry not found')
  }

  const { customFields: draftCustomFields, tags, ...rest } = write.draft
  const customMerge = await validatedCustomFieldsForUpdate(
    tx,
    workspaceId,
    'enquiry',
    existing.customFields,
    draftCustomFields,
  )
  const columns = {
    ...rest,
    tags: tags === undefined ? undefined : [...tags],
    stageId: write.stageId,
    companyId: write.companyId,
    ...(write.ownerId === null ? {} : { ownerId: write.ownerId }),
    ...(customMerge === undefined ? {} : { customFields: customMerge.merged }),
  }
  const changed = [...changedKeys(existing, columns), ...(customMerge?.changedPaths ?? [])]

  if (changed.length > 0) {
    await enquiryRepository.updateEnquiry(tx, workspaceId, id, {
      ...columns,
      updatedAt: dependencies.now,
    })
  }

  const peopleMoved = write.setsPeople
    ? await reconcileLinkedPeople(dependencies, 'enquiry', id, write.personIds)
    : false

  return {
    recordId: id,
    objectType: 'enquiry',
    changedFields: peopleMoved ? [...changed, 'personIds'] : changed,
  }
}

async function writePartnership(
  dependencies: WriteDependencies,
  plan: WritablePlan,
  write: Extract<ImportWrite, { object: 'partnerships' }>,
): Promise<WriteOutcome> {
  const { tx, workspaceId } = dependencies

  if (plan.action === 'create') {
    const id = dependencies.createId('partnership')
    const customFields = await validatedCustomFieldsForCreate(
      tx,
      workspaceId,
      'partnership',
      write.draft.customFields,
    )

    const { customFields: _draftCustomFields, tags, ...rest } = write.draft

    await partnershipRepository.insertPartnership(tx, {
      ...rest,
      tags: tags === undefined ? undefined : [...tags],
      ...(customFields === undefined ? {} : { customFields }),
      id,
      workspaceId,
      name: write.draft.name ?? '',
      kind: write.draft.kind ?? '',
      stageId: write.stageId,
      companyId: write.companyId,
      ownerId: write.ownerId,
    })
    await personLinks.linkPeople(tx, dependencies.createId, workspaceId, { targetType: 'partnership', targetId: id }, write.personIds)

    return { recordId: id, objectType: 'partnership', changedFields: [] }
  }

  const id = requireTarget(plan)
  const existing = await partnershipRepository.findPartnership(tx, workspaceId, id)

  if (existing === undefined) {
    throw AppError.notFound('Partnership not found')
  }

  const { customFields: draftCustomFields, tags, ...rest } = write.draft
  const customMerge = await validatedCustomFieldsForUpdate(
    tx,
    workspaceId,
    'partnership',
    existing.customFields,
    draftCustomFields,
  )
  const columns = {
    ...rest,
    tags: tags === undefined ? undefined : [...tags],
    stageId: write.stageId,
    companyId: write.companyId,
    ...(write.ownerId === null ? {} : { ownerId: write.ownerId }),
    ...(customMerge === undefined ? {} : { customFields: customMerge.merged }),
  }
  const changed = [...changedKeys(existing, columns), ...(customMerge?.changedPaths ?? [])]

  if (changed.length > 0) {
    await partnershipRepository.updatePartnership(tx, workspaceId, id, {
      ...columns,
      updatedAt: dependencies.now,
    })
  }

  const peopleMoved = write.setsPeople
    ? await reconcileLinkedPeople(dependencies, 'partnership', id, write.personIds)
    : false

  return {
    recordId: id,
    objectType: 'partnership',
    changedFields: peopleMoved ? [...changed, 'personIds'] : changed,
  }
}

async function writeRaise(
  dependencies: WriteDependencies,
  plan: WritablePlan,
  write: Extract<ImportWrite, { object: 'raises' }>,
): Promise<WriteOutcome> {
  const { tx, workspaceId } = dependencies

  if (plan.action === 'create') {
    const id = dependencies.createId('raise')
    const customFields = await validatedCustomFieldsForCreate(
      tx,
      workspaceId,
      'raise',
      write.draft.customFields,
    )

    const { customFields: _draftCustomFields, tags, ...rest } = write.draft

    await raiseRepository.insertRaise(tx, {
      ...rest,
      tags: tags === undefined ? undefined : [...tags],
      ...(customFields === undefined ? {} : { customFields }),
      id,
      workspaceId,
      name: write.draft.name ?? '',
      stageId: write.stageId,
      companyId: write.companyId,
      ownerId: write.ownerId,
      currency:
        write.draft.currency ??
        (write.draft.checkSizeCents === undefined || write.draft.checkSizeCents === null
          ? undefined
          : IMPORT_DEAL_CURRENCY),
    })
    await personLinks.linkPeople(tx, dependencies.createId, workspaceId, { targetType: 'raise', targetId: id }, write.personIds)

    return { recordId: id, objectType: 'raise', changedFields: [] }
  }

  const id = requireTarget(plan)
  const existing = await raiseRepository.findRaise(tx, workspaceId, id)

  if (existing === undefined) {
    throw AppError.notFound('Raise not found')
  }

  const { customFields: draftCustomFields, tags, ...rest } = write.draft
  const customMerge = await validatedCustomFieldsForUpdate(
    tx,
    workspaceId,
    'raise',
    existing.customFields,
    draftCustomFields,
  )
  const columns = {
    ...rest,
    tags: tags === undefined ? undefined : [...tags],
    stageId: write.stageId,
    companyId: write.companyId,
    ...(write.ownerId === null ? {} : { ownerId: write.ownerId }),
    ...(customMerge === undefined ? {} : { customFields: customMerge.merged }),
  }
  const changed = [...changedKeys(existing, columns), ...(customMerge?.changedPaths ?? [])]

  if (changed.length > 0) {
    await raiseRepository.updateRaise(tx, workspaceId, id, {
      ...columns,
      updatedAt: dependencies.now,
    })
  }

  const peopleMoved = write.setsPeople
    ? await reconcileLinkedPeople(dependencies, 'raise', id, write.personIds)
    : false

  return {
    recordId: id,
    objectType: 'raise',
    changedFields: peopleMoved ? [...changed, 'personIds'] : changed,
  }
}

async function writeCustomFieldDefinition(
  dependencies: WriteDependencies,
  plan: WritablePlan,
  write: Extract<ImportWrite, { object: 'custom_fields' }>,
): Promise<WriteOutcome> {
  const { tx, workspaceId } = dependencies

  if (plan.action === 'create') {
    const id = dependencies.createId('customFieldDefinition')
    const created = await customFieldRepository.insertDefinition(tx, {
      id,
      workspaceId,
      objectType: write.draft.objectType as CustomFieldObjectType,
      key: write.draft.key ?? '',
      label: write.draft.label ?? '',
      type: write.draft.type as import('../custom-fields/schema.ts').CustomFieldType,
      options: write.draft.options === undefined ? [] : [...write.draft.options],
      description: write.draft.description ?? '',
      sortOrder: write.draft.sortOrder ?? 0,
    })

    return { recordId: created.id, objectType: 'custom_field', changedFields: [] }
  }

  const id = requireTarget(plan)
  const existing = await customFieldRepository.findDefinition(tx, workspaceId, id)

  if (existing === undefined) {
    throw AppError.notFound('Custom field not found')
  }

  const columns = {
    ...(write.draft.label === undefined ? {} : { label: write.draft.label }),
    ...(write.draft.description === undefined ? {} : { description: write.draft.description }),
    ...(write.draft.options === undefined ? {} : { options: [...write.draft.options] }),
    ...(write.draft.sortOrder === undefined ? {} : { sortOrder: write.draft.sortOrder }),
  }
  const changedFields = changedKeys(existing, columns)

  if (changedFields.length > 0) {
    await customFieldRepository.updateDefinition(tx, workspaceId, id, {
      ...columns,
      updatedAt: dependencies.now,
    })
  }

  return { recordId: id, objectType: 'custom_field', changedFields }
}

/** What a timeline calls each object. */
const OBJECT_LABEL: Readonly<Record<ImportWrite['object'], string>> = {
  companies: 'Company',
  people: 'Person',
  positions: 'Position',
  deals: 'Deal',
  opportunities: 'Opportunity',
  enquiries: 'Enquiry',
  partnerships: 'Partnership',
  raises: 'Raise',
  custom_fields: 'Custom field',
}

function historyTargetType(
  write: ImportWrite,
): 'company' | 'person' | 'deal' | 'opportunity' | 'enquiry' | 'partnership' | 'raise' {
  switch (write.object) {
    case 'companies':
      return 'company'
    case 'people':
      return 'person'
    case 'deals':
      return 'deal'
    case 'opportunities':
      return 'opportunity'
    case 'enquiries':
      return 'enquiry'
    case 'partnerships':
      return 'partnership'
    case 'raises':
      return 'raise'
    default:
      throw new Error(`No history target for ${write.object}`)
  }
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

  if (write.object === 'custom_fields') {
    return
  }

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
    targetType: historyTargetType(write),
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
      case 'opportunities':
        return writeOpportunity(dependencies, plan, write)
      case 'enquiries':
        return writeEnquiry(dependencies, plan, write)
      case 'partnerships':
        return writePartnership(dependencies, plan, write)
      case 'raises':
        return writeRaise(dependencies, plan, write)
      case 'custom_fields':
        return writeCustomFieldDefinition(dependencies, plan, write)
    }
  })()

  await recordHistory(dependencies, plan, write, outcome)

  return outcome
}
