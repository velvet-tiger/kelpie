import type { FormSubmissionActionEntry, PipelineKind } from '@kelpie/schemas'

import { UNIQUE_VIOLATION, postgresErrorCode } from '../../lib/database.ts'
import type { Database } from '../../lib/database.ts'
import { AppError } from '../../lib/errors.ts'
import type { IdFactory } from '../../lib/ids.ts'
import { requireCapability } from '../../runtime/entitlements.ts'
import type { EntitlementRegistry } from '../../runtime/entitlements.ts'
import { moduleCapabilityName } from '../../runtime/moduleConfig.ts'
import type { BufferedEvents, Transaction, TransactionScope } from '../../runtime/transaction.ts'
import type { ActivityRecorder, SystemActor } from '../activities/recorder.ts'
import { describeCreationVia, describeFormSubmission } from '../activities/wording.ts'
import '../companies/events.ts'
import * as companyRepository from '../companies/repository.ts'
import type { CompanyRecord } from '../companies/repository.ts'
import * as dealRepository from '../deals/repository.ts'
import '../deals/events.ts'
import * as enquiryRepository from '../enquiries/repository.ts'
import '../enquiries/events.ts'
import '../lists/events.ts'
import * as listsRepository from '../lists/repository.ts'
import * as opportunityRepository from '../opportunities/repository.ts'
import '../opportunities/events.ts'
import * as partnershipRepository from '../partnerships/repository.ts'
import '../partnerships/events.ts'
import * as consentPurposesRepository from '../consent-purposes/repository.ts'
import * as customFieldsRepository from '../custom-fields/repository.ts'
import { CUSTOM_FIELD_OBJECT_TYPES } from '../custom-fields/schema.ts'
import '../people/events.ts'
import { upsertPersonConsent } from '../people/personConsentWrites.ts'
import * as peopleRepository from '../people/repository.ts'
import type { PersonRecord } from '../people/repository.ts'
import * as personLinks from '../personLinks.ts'
import * as pipelineRepository from '../pipelines/repository.ts'
import '../positions/events.ts'
import * as positionRepository from '../positions/repository.ts'
import { targetExists } from '../recordTargets.ts'
import * as raiseRepository from '../raises/repository.ts'
import '../raises/events.ts'
import * as workspaceRepository from '../workspace/repository.ts'
import './events.ts'
import {
  DEAL_CLOSE_HORIZON_DAYS,
  companyNameFrom,
  describeAnswers,
  expandNameTemplate,
  expectedCloseFrom,
  fillBlank,
  fillPhonesBlank,
  findAnswerProblems,
  mapAnswers,
  mergeTags,
  readConsentGrants,
  readIntent,
} from './mapping.ts'
import type { Answers, ConsentGrant, SubmitIntent } from './mapping.ts'
import * as repository from './repository.ts'
import type { FormFieldRecord, FormRecord } from './repository.ts'
import {
  applyCompanyMappedFields,
  applyDealMappedFields,
  applyEnquiryMappedFields,
  applyOpportunityMappedFields,
  applyPartnershipMappedFields,
  applyPersonMappedFields,
  applyRaiseMappedFields,
} from './applySubmissionFields.ts'

/**
 * The public submit: `forms.md` rules 1 to 7, server-side.
 *
 * This is the port of `processFormSubmission` from `mockups/src/data/seed.ts`.
 * The pure half of those rules lives in `mapping.ts`; what is left here is the
 * upserts, in one transaction, so a submission never records a person that was
 * rolled back.
 *
 * Nothing in this file takes an `Actor`. A submit arrives with no credentials,
 * and the only thing naming a workspace is the form's `publicKey`. Every query
 * below is scoped to the workspace read off that form.
 */

/** What the timeline calls a row a form wrote. */
const FORM_ACTOR: SystemActor = { kind: 'system', label: 'Form' }

/**
 * Used when a form creates deals and nobody wrote a name template.
 *
 * The board has to show something, and the company is what a reader of an
 * inbound deal looks for. The mockup's own default adds " — website"; that
 * belongs to a form somebody configured, not to the fallback.
 */
const DEFAULT_DEAL_NAME_TEMPLATE = '{{company.name}}'

/**
 * Defaults for a Company a submit invents, from `forms.md` rule 4.
 *
 * `sizeBand` is not in that list and the column is `NOT NULL`, so it takes the
 * smallest band: the honest reading of a company nobody has told us anything
 * about yet.
 */
const NEW_COMPANY_DEFAULTS = {
  stage: 'other',
  sizeBand: '1-10',
  accountType: 'prospect',
  icpFit: 'unknown',
} as const

/**
 * Defaults for a Person a submit invents, from `forms.md`.
 *
 * No tags. The mockup tags new records `inbound` and `form`; `forms.md` says the
 * summary and tags start empty, and provenance is already carried by the
 * timeline entry and by the FormSubmission's own links.
 */
const NEW_PERSON_DEFAULTS = {
  relationship: 'cold',
  preferredChannel: 'email',
  influence: 'influencer',
} as const

export interface SubmissionDependencies {
  readonly db: Database
  readonly transaction: TransactionScope
  readonly createId: IdFactory
  readonly now: () => Date
  readonly recordActivity: ActivityRecorder
  /** A submit into a workspace that has turned the forms module off is refused. */
  readonly entitlements: EntitlementRegistry
}

/** What the submit created or matched. Each id is null when the rule did not apply. */
export interface SubmitOutcome {
  readonly submissionId: string
  readonly formId: string
  readonly personId: string
  readonly companyId: string | null
  readonly positionId: string | null
  readonly dealId: string | null
  readonly opportunityId: string | null
  readonly partnershipId: string | null
  readonly enquiryId: string | null
  readonly submittedAt: Date
  /** Echoed so an embed can render it without a second request. */
  readonly thankYouMessage: string
  /**
   * Per-action outcome from the post-submit runner, in the order attempted.
   * Empty for a form with no post-actions configured. Never crosses the public
   * wire (see `publicRoutes.ts`); the authenticated Submissions read carries
   * it in full.
   */
  readonly actionLog: readonly FormSubmissionActionEntry[]
}

export interface FormSubmitService {
  /** @throws AppError 404 unknown key, 409 paused, 422 unusable answers. */
  submit(publicKey: string, answers: Answers): Promise<SubmitOutcome>
}

/**
 * One post-submit action's outcome, as its `work` returns it. `skipped`
 * means the action was configured but its precondition was absent (a
 * company-tag merge on a submit that resolved no company); the runner logs
 * it and moves on. `ok` means the action ran; the runner forwards every
 * event the action emitted.
 */
interface ActionResult<T> {
  readonly status: 'ok' | 'skipped'
  readonly detail: string
  readonly value?: T
}

/** One event pending forwarding after a savepoint's `ok` return. */
interface PendingEvent {
  readonly name: Parameters<BufferedEvents['emit']>[0]
  readonly target: Parameters<BufferedEvents['emit']>[1]
  readonly data: unknown
}

/** A record, and whether this submit is what put it there. */
interface Upserted<TRecord extends { readonly id: string }> {
  readonly record: TRecord
  readonly created: boolean
  /** Columns this submit filled in on an existing record. Empty on a create. */
  readonly filled: readonly string[]
}

/** The bare shape `emitRecordEvents` needs of a Position. */
interface PositionLink {
  readonly id: string
}

/** What a submit touched, for the events published after commit. */
interface TouchedRecords {
  readonly person: Upserted<PersonRecord>
  readonly company: Upserted<CompanyRecord> | undefined
  readonly position: Upserted<PositionLink> | undefined
}

/**
 * One `record.created` per record this submit invented (person, company,
 * position), and one `record.updated` per record it filled a blank on. The
 * pipeline creates (deal, opportunity, partnership) publish their own
 * `*.created` events from inside their action's shim so a rolled-back
 * savepoint drops the event alongside the row.
 *
 * A submit that matched an existing person and changed nothing about them
 * emits neither: a consumer mirroring the CRM has nothing to mirror, and
 * `form.submitted` already says the submission happened.
 */
function emitRecordEvents(
  events: BufferedEvents,
  workspaceId: string,
  touched: TouchedRecords,
): void {
  emitUpsertEvent(events, 'person', touched.person)

  if (touched.company !== undefined) {
    emitUpsertEvent(events, 'company', touched.company)
  }
  if (touched.position !== undefined) {
    emitUpsertEvent(events, 'position', touched.position)
  }

  // workspaceId is used by the transaction scope's envelope stamping; the
  // parameter stays on the signature so future call sites keep the same shape.
  void workspaceId
}

/**
 * Dispatches the created/updated event owned by the record's module for one
 * upsert. Split from the loop above so TypeScript can correlate the object
 * type with its typed event name at each call site.
 */
function emitUpsertEvent(
  events: BufferedEvents,
  objectType: 'person' | 'company' | 'position',
  outcome: { readonly created: boolean; readonly record: { readonly id: string }; readonly filled: readonly string[] },
): void {
  if (outcome.created) {
    switch (objectType) {
      case 'person':
        events.emit('people.person.created', { type: 'person', id: outcome.record.id }, {})
        return
      case 'company':
        events.emit('companies.company.created', { type: 'company', id: outcome.record.id }, {})
        return
      case 'position':
        events.emit(
          'positions.position.created',
          { type: 'position', id: outcome.record.id },
          {},
        )
        return
    }
  }

  if (outcome.filled.length === 0) {
    return
  }

  const changed = outcome.filled

  switch (objectType) {
    case 'person':
      events.emit(
        'people.person.updated',
        { type: 'person', id: outcome.record.id },
        { changed },
      )
      return
    case 'company':
      events.emit(
        'companies.company.updated',
        { type: 'company', id: outcome.record.id },
        { changed },
      )
      return
    case 'position':
      events.emit(
        'positions.position.updated',
        { type: 'position', id: outcome.record.id },
        { changed },
      )
      return
  }
}

export function createFormSubmitService(dependencies: SubmissionDependencies): FormSubmitService {
  /**
   * Upserts the Person, matched on the normalised address.
   *
   * `lastContactedAt` is stamped either way, and unlike every other field it
   * overwrites: it records when this person was last in touch, and filling the
   * form in is them being in touch. It is not reported as a filled blank,
   * because a consumer watching for enrichment does not want a notification
   * every time somebody says hello.
   */
  async function upsertPerson(
    tx: Transaction,
    workspaceId: string,
    intent: SubmitIntent,
  ): Promise<Upserted<PersonRecord>> {
    const now = dependencies.now()
    const existing = await peopleRepository.findPersonByEmail(tx, workspaceId, intent.email)

    if (existing === undefined) {
      const phones = fillPhonesBlank([], intent.personPhone)
      const created = await peopleRepository.insertPerson(tx, {
        id: dependencies.createId('person'),
        workspaceId,
        name: intent.personName,
        firstName: intent.personFirstName ?? null,
        lastName: intent.personLastName ?? null,
        email: intent.email,
        lastContactedAt: now,
        ...(phones === undefined ? {} : { phones: [...phones] }),
        ...NEW_PERSON_DEFAULTS,
      })

      return { record: created, created: true, filled: phones === undefined ? [] : ['phones'] }
    }

    // Each part fills its own blank. A stored first name is what the team has
    // learned and an inbound one is what a visitor typed, so the rule that keeps
    // an inbound "Alex" off a stored "Alex Rivera" covers these unchanged.
    const filledName = fillBlank(existing.name, intent.personName)
    const filledFirstName = fillBlank(existing.firstName, intent.personFirstName)
    const filledLastName = fillBlank(existing.lastName, intent.personLastName)
    const filledPhones = fillPhonesBlank(existing.phones, intent.personPhone)
    const changes = {
      ...(filledName === undefined ? {} : { name: filledName }),
      ...(filledFirstName === undefined ? {} : { firstName: filledFirstName }),
      ...(filledLastName === undefined ? {} : { lastName: filledLastName }),
      ...(filledPhones === undefined ? {} : { phones: [...filledPhones] }),
    }
    const updated = await peopleRepository.updatePerson(tx, workspaceId, existing.id, {
      ...changes,
      lastContactedAt: now,
      updatedAt: now,
    })

    if (updated === undefined) {
      throw new Error(`Person ${existing.id} disappeared during a form submit`)
    }

    return { record: updated, created: false, filled: Object.keys(changes) }
  }

  /**
   * Upserts the Company, by domain when there is one and by name otherwise
   * (`forms.md` rule 4).
   *
   * @returns undefined when the answers said nothing about a company, which is
   *   the ordinary case for a form collecting only a name and an address.
   */
  async function upsertCompany(
    tx: Transaction,
    workspaceId: string,
    intent: SubmitIntent,
  ): Promise<Upserted<CompanyRecord> | undefined> {
    const name = companyNameFrom(intent)

    if (name === undefined) {
      return undefined
    }

    const byDomain =
      intent.companyDomain === undefined
        ? undefined
        : await companyRepository.findCompanyByDomain(tx, workspaceId, intent.companyDomain)
    const existing =
      byDomain ??
      (intent.companyName === undefined
        ? undefined
        : await companyRepository.findCompanyByName(tx, workspaceId, intent.companyName))

    if (existing === undefined) {
      const created = await companyRepository.insertCompany(tx, {
        id: dependencies.createId('company'),
        workspaceId,
        name,
        domain: intent.companyDomain ?? null,
        ...NEW_COMPANY_DEFAULTS,
      })

      return { record: created, created: true, filled: [] }
    }

    const filledName = fillBlank(existing.name, intent.companyName)
    const filledDomain = fillBlank(existing.domain, intent.companyDomain)
    const changes = {
      ...(filledName === undefined ? {} : { name: filledName }),
      ...(filledDomain === undefined ? {} : { domain: filledDomain }),
    }
    const filled = Object.keys(changes)

    if (filled.length === 0) {
      return { record: existing, created: false, filled }
    }

    const updated = await companyRepository.updateCompany(tx, workspaceId, existing.id, {
      ...changes,
      updatedAt: dependencies.now(),
    })

    if (updated === undefined) {
      throw new Error(`Company ${existing.id} disappeared during a form submit`)
    }

    return { record: updated, created: false, filled }
  }

  /**
   * Links the person to the company, if a title arrived.
   *
   * A submit never creates a second Position at a company the person already
   * holds one at. An inbound "VP Sales" from somebody the team recorded as
   * "Sales Director" is the same job described differently, and two rows would
   * put them on the company page twice. The stored title wins, as everywhere
   * else in a submit.
   */
  async function upsertPosition(
    tx: Transaction,
    workspaceId: string,
    personId: string,
    companyId: string,
    title: string,
  ): Promise<Upserted<PositionLink>> {
    const held = await positionRepository.listPositionsAt(tx, workspaceId, personId, companyId)
    const existing =
      held.find((position) => position.title.toLowerCase() === title.toLowerCase()) ?? held[0]

    if (existing !== undefined) {
      return { record: existing, created: false, filled: [] }
    }

    const created = await positionRepository.insertPosition(tx, {
      id: dependencies.createId('position'),
      workspaceId,
      personId,
      companyId,
      title,
    })

    return { record: created, created: true, filled: [] }
  }

  /**
   * The stage a form's created record opens in: the one the form names, or
   * the pipeline's first open stage. Shared by the three create-triggers.
   */
  async function openingStageId(
    tx: Transaction,
    workspaceId: string,
    kind: PipelineKind,
    configured: string | null,
  ): Promise<string> {
    if (configured !== null) {
      return configured
    }

    const stages = await pipelineRepository.listStagesOfKind(tx, workspaceId, kind)
    const first = stages.find((stage) => stage.open) ?? stages[0]

    if (first === undefined) {
      // Unreachable through the API: a workspace seeds its stages at creation
      // and the last stage of a pipeline cannot be removed.
      throw AppError.conflict(`This workspace has no ${kind} stages`)
    }

    return first.id
  }

  /**
   * Runs `work` under a nested `tx.transaction()` — a SAVEPOINT in
   * postgres-js — and captures every event the action emits into a local
   * buffer. On success (`ok` or `skipped`) the events are forwarded to the
   * real `BufferedEvents`; on throw the savepoint has already rolled back so
   * the events are discarded and a `{status: 'error'}` entry lands on the log.
   * Either way the outer transaction stays alive: the next action runs, and
   * the visitor's 201 survives.
   */
  async function runAction<T>(
    tx: Transaction,
    events: BufferedEvents,
    log: FormSubmissionActionEntry[],
    action: string,
    work: (inner: Transaction, emit: BufferedEvents['emit']) => Promise<ActionResult<T>>,
  ): Promise<T | undefined> {
    const pending: PendingEvent[] = []
    const emit: BufferedEvents['emit'] = (name, target, data) => {
      pending.push({ name, target, data })
    }

    try {
      const result = await tx.transaction(async (inner) => work(inner, emit))
      log.push({ action, status: result.status, detail: result.detail })

      for (const event of pending) {
        // The typed emit rejects an unrelated (name, data) pair; the shim
        // captured them as one call so the pair is already validated.
        events.emit(event.name, event.target, event.data as never)
      }

      return result.value
    } catch (error: unknown) {
      const detail =
        error instanceof AppError
          ? error.message
          : error instanceof Error
            ? error.message
            : 'unknown error'
      log.push({ action, status: 'error', detail })

      return undefined
    }
  }

  /**
   * Creates the Deal, when the form makes them and a company was resolved.
   *
   * A deal belongs to a company (`deals.company_id` is `NOT NULL`), so a submit
   * that resolved none creates no deal and says so through a null `deal_id` on
   * the submission rather than by inventing one.
   */
  async function createDeal(
    tx: Transaction,
    emit: BufferedEvents['emit'],
    workspaceId: string,
    form: FormRecord,
    intent: SubmitIntent,
    company: CompanyRecord,
    personId: string,
  ): Promise<string> {
    const id = dependencies.createId('deal')
    const owner = await workspaceRepository.findDefaultMember(tx, workspaceId)

    await dealRepository.insertDeal(tx, {
      id,
      workspaceId,
      name:
        intent.dealName ??
        expandNameTemplate(form.dealNameTemplate ?? DEFAULT_DEAL_NAME_TEMPLATE, {
          companyName: company.name,
          personName: intent.personName,
        }),
      companyId: company.id,
      stageId: await openingStageId(tx, workspaceId, 'deal', form.dealStageId),
      valueCents: 0,
      currency: null,
      ownerId: owner?.id ?? null,
      expectedClose: expectedCloseFrom(dependencies.now(), DEAL_CLOSE_HORIZON_DAYS),
    })

    await personLinks.linkPeople(
      tx,
      dependencies.createId,
      workspaceId,
      { targetType: 'deal', targetId: id },
      [personId],
    )

    await dependencies.recordActivity(tx, workspaceId, FORM_ACTOR, {
      targetType: 'deal',
      targetId: id,
      kind: 'created',
      ...describeCreationVia('Deal', form.name),
    })

    emit('deals.deal.created', { type: 'deal', id }, {})

    return id
  }

  /**
   * Creates the Opportunity, when the form makes them.
   *
   * `opportunities.company_id` is nullable, so a submit that resolved no
   * company still creates the opportunity, with the company link null. The
   * kind is required at form-write time (see `service.ts`), so it is always
   * present here.
   */
  async function createOpportunity(
    tx: Transaction,
    emit: BufferedEvents['emit'],
    workspaceId: string,
    form: FormRecord,
    intent: SubmitIntent,
    company: CompanyRecord | undefined,
    personId: string,
  ): Promise<string> {
    const id = dependencies.createId('opportunity')
    const owner =
      form.opportunityOwnerId === null
        ? await workspaceRepository.findDefaultMember(tx, workspaceId)
        : { id: form.opportunityOwnerId }

    await opportunityRepository.insertOpportunity(tx, {
      id,
      workspaceId,
      name:
        intent.opportunityName ??
        expandNameTemplate(form.opportunityNameTemplate ?? DEFAULT_DEAL_NAME_TEMPLATE, {
          companyName: company?.name ?? '',
          personName: intent.personName,
        }),
      // requireKindWhenCreating refuses an empty kind at write; the ?? is a
      // narrowing convenience, not a runtime fallback.
      kind: form.opportunityKind ?? '',
      stageId: await openingStageId(tx, workspaceId, 'opportunity', form.opportunityStageId),
      companyId: company?.id ?? null,
      ownerId: owner?.id ?? null,
      expectedClose: expectedCloseFrom(dependencies.now(), DEAL_CLOSE_HORIZON_DAYS),
    })

    await personLinks.linkPeople(
      tx,
      dependencies.createId,
      workspaceId,
      { targetType: 'opportunity', targetId: id },
      [personId],
    )

    await dependencies.recordActivity(tx, workspaceId, FORM_ACTOR, {
      targetType: 'opportunity',
      targetId: id,
      kind: 'created',
      ...describeCreationVia('Opportunity', form.name),
    })

    emit('opportunities.opportunity.created', { type: 'opportunity', id }, {})

    return id
  }

  /**
   * Creates the Partnership, when the form makes them and a company was
   * resolved. `partnerships.company_id` is `NOT NULL`, matching Deal.
   */
  async function createPartnership(
    tx: Transaction,
    emit: BufferedEvents['emit'],
    workspaceId: string,
    form: FormRecord,
    intent: SubmitIntent,
    company: CompanyRecord,
    personId: string,
  ): Promise<string> {
    const id = dependencies.createId('partnership')
    const owner =
      form.partnershipOwnerId === null
        ? await workspaceRepository.findDefaultMember(tx, workspaceId)
        : { id: form.partnershipOwnerId }
    const nextTouchpoint = expectedCloseFrom(dependencies.now(), DEAL_CLOSE_HORIZON_DAYS)

    await partnershipRepository.insertPartnership(tx, {
      id,
      workspaceId,
      name:
        intent.partnershipName ??
        expandNameTemplate(form.partnershipNameTemplate ?? DEFAULT_DEAL_NAME_TEMPLATE, {
          companyName: company.name,
          personName: intent.personName,
        }),
      companyId: company.id,
      stageId: await openingStageId(tx, workspaceId, 'partnership', form.partnershipStageId),
      kind: form.partnershipKind ?? '',
      nextTouchpoint,
      ownerId: owner?.id ?? null,
      goals: '',
      successLooksLike: '',
    })

    await personLinks.linkPeople(
      tx,
      dependencies.createId,
      workspaceId,
      { targetType: 'partnership', targetId: id },
      [personId],
    )

    await dependencies.recordActivity(tx, workspaceId, FORM_ACTOR, {
      targetType: 'partnership',
      targetId: id,
      kind: 'created',
      ...describeCreationVia('Partnership', form.name),
    })

    emit('partnerships.partnership.created', { type: 'partnership', id }, {})

    return id
  }

  /**
   * Creates the Enquiry, when the form makes them.
   *
   * `enquiries.company_id` is nullable, so a submit that resolved no company
   * still creates the enquiry. Enquiries have no `kind`; the form's optional
   * `enquirySource` is written to the enquiry's `source` column, or empty when
   * unset — an unclassified source reads as unclassified.
   */
  async function createEnquiry(
    tx: Transaction,
    emit: BufferedEvents['emit'],
    workspaceId: string,
    form: FormRecord,
    intent: SubmitIntent,
    company: CompanyRecord | undefined,
    personId: string,
  ): Promise<string> {
    const id = dependencies.createId('enquiry')
    const owner =
      form.enquiryOwnerId === null
        ? await workspaceRepository.findDefaultMember(tx, workspaceId)
        : { id: form.enquiryOwnerId }

    await enquiryRepository.insertEnquiry(tx, {
      id,
      workspaceId,
      name:
        intent.enquiryName ??
        expandNameTemplate(form.enquiryNameTemplate ?? DEFAULT_DEAL_NAME_TEMPLATE, {
          companyName: company?.name ?? '',
          personName: intent.personName,
        }),
      source: form.enquirySource ?? '',
      stageId: await openingStageId(tx, workspaceId, 'enquiry', form.enquiryStageId),
      companyId: company?.id ?? null,
      ownerId: owner?.id ?? null,
      convertedDealId: null,
    })

    await personLinks.linkPeople(
      tx,
      dependencies.createId,
      workspaceId,
      { targetType: 'enquiry', targetId: id },
      [personId],
    )

    await dependencies.recordActivity(tx, workspaceId, FORM_ACTOR, {
      targetType: 'enquiry',
      targetId: id,
      kind: 'created',
      ...describeCreationVia('Enquiry', form.name),
    })

    emit('enquiries.enquiry.created', { type: 'enquiry', id }, {})

    return id
  }

  /**
   * The form behind a public key, ready to accept answers.
   *
   * @throws AppError 404 for an unknown key, 409 for a paused form (`forms.md`).
   */
  async function requireOpenForm(publicKey: string): Promise<FormRecord> {
    const form = await repository.findFormByPublicKey(dependencies.db, publicKey)

    // An unknown key is indistinguishable from one whose form was deleted, and
    // the caller is a website with no credentials: it learns nothing either way.
    if (form === undefined) {
      throw AppError.notFound('Form not found')
    }

    // The public surface is ungated by the runtime (`runtime/registry.ts` gates
    // only credentialled routes), so a workspace that has turned the forms
    // module off is refused here, the same 403 the REST surface gives.
    await requireCapability(dependencies.entitlements, form.workspaceId, moduleCapabilityName('forms'))

    if (form.status === 'paused') {
      throw AppError.conflict('This form is not accepting submissions')
    }

    return form
  }

  /** @throws AppError 422 listing everything wrong with the answers at once. */
  function readAnswers(fields: readonly FormFieldRecord[], answers: Answers): SubmitIntent {
    const problems = findAnswerProblems(fields, answers)

    if (problems.length > 0) {
      throw AppError.validationFailed('Those answers are not ones this form accepts', problems)
    }

    const intent = readIntent(mapAnswers(fields, answers))

    if (intent === undefined) {
      throw AppError.validationFailed('This form needs an email address', [
        { field: 'answers', message: 'No usable person.email answer' },
      ])
    }

    return intent
  }

  /**
   * The purposes any grants name, keyed by id, so the submit transaction
   * knows the slug and label without a per-grant round trip.
   */
  async function loadPurposesForGrants(
    db: Database,
    workspaceId: string,
    grants: readonly ConsentGrant[],
  ): Promise<ReadonlyMap<string, { readonly slug: string; readonly label: string }>> {
    if (grants.length === 0) return new Map()
    const ids = Array.from(new Set(grants.map((grant) => grant.purposeId)))
    const rows = await consentPurposesRepository.listPurposesByIds(db, workspaceId, ids)
    return new Map(rows.map((row) => [row.id, { slug: row.slug, label: row.label }]))
  }

  /**
   * Writes each ticked grant as a `person_consents` row and appends an
   * Activity to the person carrying the verbatim statement. A grant whose
   * purpose has since been removed is silently skipped — the form's own
   * consent field would have been left dangling anyway, and the submit
   * cannot know that from the answer alone.
   */
  async function applyFormConsentGrants(
    tx: Transaction,
    workspaceId: string,
    formId: string,
    formName: string,
    personId: string,
    grants: readonly ConsentGrant[],
    purposes: ReadonlyMap<string, { readonly slug: string; readonly label: string }>,
    deps: SubmissionDependencies,
  ): Promise<void> {
    if (grants.length === 0) return
    const now = deps.now()
    const source = `form:${formId}`
    for (const grant of grants) {
      const purpose = purposes.get(grant.purposeId)
      if (purpose === undefined) continue
      await upsertPersonConsent(
        tx,
        workspaceId,
        personId,
        grant.purposeId,
        purpose.slug,
        purpose.label,
        'granted',
        source,
        now,
      )
      // The exact text the visitor ticked — the field's per-purpose override
      // when set, else the workspace purpose's label. Recorded as the
      // Activity detail so the timeline shows what they actually saw.
      const ticked = grant.customLabel.length > 0 ? grant.customLabel : purpose.label
      const detail = grant.statement.length > 0 ? `${grant.statement} — ${ticked}` : ticked
      await deps.recordActivity(tx, workspaceId, FORM_ACTOR, {
        targetType: 'person',
        targetId: personId,
        kind: 'updated',
        action: `granted ${purpose.label} consent via ${formName}`,
        detail,
      })
    }
  }

  return {
    async submit(publicKey, answers) {
      const form = await requireOpenForm(publicKey)
      const { workspaceId } = form
      const fields = await repository.listFields(dependencies.db, form.id)
      const intent = readAnswers(fields, answers)
      const mapped = mapAnswers(fields, answers)
      const consentGrants = readConsentGrants(fields, answers)
      const customFieldDefinitions = (
        await Promise.all(
          CUSTOM_FIELD_OBJECT_TYPES.map((objectType) =>
            customFieldsRepository.definitionsForObject(dependencies.db, workspaceId, objectType),
          ),
        )
      ).flat()
      const [formListRows, attachTargets, consentPurposesForGrants] = await Promise.all([
        repository.listFormLists(dependencies.db, form.id),
        repository.listAttachTargets(dependencies.db, form.id),
        loadPurposesForGrants(dependencies.db, workspaceId, consentGrants),
      ])

      return dependencies.transaction(async ({ tx, events }) => {
        const now = dependencies.now()
        // Core capture: atomic. A failure here fails the submit; every
        // post-action below runs under its own savepoint and logs.
        const personUpserted = await upsertPerson(tx, workspaceId, intent)
        const personRecord = await applyPersonMappedFields(
          tx,
          workspaceId,
          personUpserted.record,
          mapped,
          customFieldDefinitions,
          now,
        )
        const person = { ...personUpserted, record: personRecord }

        const companyUpserted = await upsertCompany(tx, workspaceId, intent)
        const companyRecord =
          companyUpserted === undefined
            ? undefined
            : await applyCompanyMappedFields(
                tx,
                workspaceId,
                companyUpserted.record,
                mapped,
                customFieldDefinitions,
                now,
              )
        const company =
          companyUpserted === undefined
            ? undefined
            : { ...companyUpserted, record: companyRecord ?? companyUpserted.record }
        const position =
          company === undefined || intent.positionTitle === undefined
            ? undefined
            : await upsertPosition(
                tx,
                workspaceId,
                person.record.id,
                company.record.id,
                intent.positionTitle,
              )

        // Consent grants (from ticked `consent` fields) are core capture, not
        // post-actions: they commit with the person, and an Activity records
        // the exact statement text as it was shown to the visitor.
        await applyFormConsentGrants(
          tx,
          workspaceId,
          form.id,
          form.name,
          person.record.id,
          consentGrants,
          consentPurposesForGrants,
          dependencies,
        )

        const actionLog: FormSubmissionActionEntry[] = []

        // --- Create triggers ---

        const dealId = form.createDeal
          ? ((await runAction<string>(tx, events, actionLog, 'create_deal', async (inner, emit) => {
              if (company === undefined) {
                return { status: 'skipped', detail: 'no company resolved' }
              }
              const id = await createDeal(
                inner,
                emit,
                workspaceId,
                form,
                intent,
                company.record,
                person.record.id,
              )

              return { status: 'ok', detail: id, value: id }
            })) ?? null)
          : null

        const opportunityId = form.createOpportunity
          ? ((await runAction<string>(
              tx,
              events,
              actionLog,
              'create_opportunity',
              async (inner, emit) => {
                const id = await createOpportunity(
                  inner,
                  emit,
                  workspaceId,
                  form,
                  intent,
                  company?.record,
                  person.record.id,
                )

                return { status: 'ok', detail: id, value: id }
              },
            )) ?? null)
          : null

        const partnershipId = form.createPartnership
          ? ((await runAction<string>(
              tx,
              events,
              actionLog,
              'create_partnership',
              async (inner, emit) => {
                if (company === undefined) {
                  return { status: 'skipped', detail: 'no company resolved' }
                }
                const id = await createPartnership(
                  inner,
                  emit,
                  workspaceId,
                  form,
                  intent,
                  company.record,
                  person.record.id,
                )

                return { status: 'ok', detail: id, value: id }
              },
            )) ?? null)
          : null

        const enquiryId = form.createEnquiry
          ? ((await runAction<string>(
              tx,
              events,
              actionLog,
              'create_enquiry',
              async (inner, emit) => {
                const id = await createEnquiry(
                  inner,
                  emit,
                  workspaceId,
                  form,
                  intent,
                  company?.record,
                  person.record.id,
                )

                return { status: 'ok', detail: id, value: id }
              },
            )) ?? null)
          : null

        if (dealId !== null) {
          const deal = await dealRepository.findDeal(tx, workspaceId, dealId)

          if (deal !== undefined) {
            await applyDealMappedFields(
              tx,
              workspaceId,
              deal,
              mapped,
              customFieldDefinitions,
              now,
            )
          }
        }

        if (opportunityId !== null) {
          const opportunity = await opportunityRepository.findOpportunity(tx, workspaceId, opportunityId)

          if (opportunity !== undefined) {
            await applyOpportunityMappedFields(
              tx,
              workspaceId,
              opportunity,
              mapped,
              customFieldDefinitions,
              now,
            )
          }
        }

        if (partnershipId !== null) {
          const partnership = await partnershipRepository.findPartnership(tx, workspaceId, partnershipId)

          if (partnership !== undefined) {
            await applyPartnershipMappedFields(
              tx,
              workspaceId,
              partnership,
              mapped,
              customFieldDefinitions,
              now,
            )
          }
        }

        if (enquiryId !== null) {
          const enquiry = await enquiryRepository.findEnquiry(tx, workspaceId, enquiryId)

          if (enquiry !== undefined) {
            await applyEnquiryMappedFields(
              tx,
              workspaceId,
              enquiry,
              mapped,
              customFieldDefinitions,
              now,
            )
          }
        }

        // --- Tag merges ---

        if (form.personTags.length > 0) {
          await runAction<void>(tx, events, actionLog, 'tag_person', async (inner, emit) => {
            const merged = mergeTags(person.record.tags, form.personTags)

            if (!merged.changed) {
              return { status: 'ok', detail: 'no new tags' }
            }

            const now = dependencies.now()
            await peopleRepository.updatePerson(inner, workspaceId, person.record.id, {
              tags: [...merged.next],
              updatedAt: now,
            })
            emit(
              'people.person.updated',
              { type: 'person', id: person.record.id },
              { changed: ['tags'] },
            )

            return { status: 'ok', detail: `merged ${String(merged.next.length - person.record.tags.length)}` }
          })
        }

        if (form.companyTags.length > 0) {
          await runAction<void>(tx, events, actionLog, 'tag_company', async (inner, emit) => {
            if (company === undefined) {
              return { status: 'skipped', detail: 'no company resolved' }
            }

            const merged = mergeTags(company.record.tags, form.companyTags)

            if (!merged.changed) {
              return { status: 'ok', detail: 'no new tags' }
            }

            const now = dependencies.now()
            await companyRepository.updateCompany(inner, workspaceId, company.record.id, {
              tags: [...merged.next],
              updatedAt: now,
            })
            emit(
              'companies.company.updated',
              { type: 'company', id: company.record.id },
              { changed: ['tags'] },
            )

            return { status: 'ok', detail: `merged ${String(merged.next.length - company.record.tags.length)}` }
          })
        }

        // --- List memberships ---

        for (const row of formListRows) {
          await runAction<boolean>(
            tx,
            events,
            actionLog,
            `add_list:${row.listId}`,
            async (inner, emit) => {
              const targetId =
                row.targetType === 'person'
                  ? person.record.id
                  : row.targetType === 'company' && company !== undefined
                    ? company.record.id
                    : undefined

              if (targetId === undefined) {
                return { status: 'skipped', detail: 'no company resolved', value: false }
              }

              try {
                await listsRepository.insertListMember(inner, {
                  id: dependencies.createId('listMember'),
                  workspaceId,
                  listId: row.listId,
                  targetType: row.targetType,
                  targetId,
                  addedAt: dependencies.now(),
                })
              } catch (error: unknown) {
                if (postgresErrorCode(error) === UNIQUE_VIOLATION) {
                  return { status: 'ok', detail: 'already a member', value: false }
                }

                throw error
              }

              emit(
                'lists.member.added',
                { type: row.targetType, id: targetId },
                { listId: row.listId },
              )

              return { status: 'ok', detail: targetId, value: true }
            },
          )
        }

        // --- Attach the submitter to pre-existing pipeline records ---

        for (const target of attachTargets) {
          await runAction<void>(
            tx,
            events,
            actionLog,
            `attach:${target.targetType}:${target.targetId}`,
            async (inner) => {
              // Racing a target delete would fail the FK-less insert with the
              // same effect as an existence check: log an error, continue.
              if (!(await targetExists(inner, workspaceId, target.targetType, target.targetId))) {
                throw AppError.notFound(`${target.targetType} ${target.targetId} not found`)
              }

              const inserted = await personLinks.linkPersonIfAbsent(
                inner,
                dependencies.createId,
                workspaceId,
                target,
                person.record.id,
              )

              return {
                status: 'ok',
                detail: inserted ? 'linked' : 'already linked',
              }
            },
          )
        }

        for (const target of attachTargets) {
          if (target.targetType !== 'raise') {
            continue
          }

          const raise = await raiseRepository.findRaise(tx, workspaceId, target.targetId)

          if (raise !== undefined) {
            await applyRaiseMappedFields(
              tx,
              workspaceId,
              raise,
              mapped,
              customFieldDefinitions,
              now,
            )
          }
        }

        // --- Persist submission + core activity + record events ---

        const submission = await repository.insertSubmission(tx, {
          id: dependencies.createId('formSubmission'),
          workspaceId,
          formId: form.id,
          answers,
          personId: person.record.id,
          companyId: company?.record.id ?? null,
          positionId: position?.record.id ?? null,
          dealId,
          opportunityId,
          partnershipId,
          enquiryId,
          submittedAt: dependencies.now(),
          actionLog,
        })

        await dependencies.recordActivity(tx, workspaceId, FORM_ACTOR, {
          targetType: 'person',
          targetId: person.record.id,
          kind: 'created',
          ...describeFormSubmission(form.name, describeAnswers(fields, answers)),
        })

        emitRecordEvents(events, workspaceId, { person, company, position })
        events.emit(
          'forms.submission.submitted',
          { type: 'submission', id: submission.id },
          {
            formId: form.id,
            submissionId: submission.id,
            opportunityId,
            partnershipId,
            enquiryId,
            actions: actionLog.map((entry) => ({ action: entry.action, status: entry.status })),
          },
        )

        return {
          submissionId: submission.id,
          formId: form.id,
          personId: person.record.id,
          companyId: company?.record.id ?? null,
          positionId: position?.record.id ?? null,
          dealId,
          opportunityId,
          partnershipId,
          enquiryId,
          submittedAt: submission.submittedAt,
          thankYouMessage: form.thankYouMessage,
          actionLog,
        }
      }, { workspaceId })
    },
  }
}
