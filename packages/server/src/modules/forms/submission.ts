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
import '../people/events.ts'
import * as peopleRepository from '../people/repository.ts'
import type { PersonRecord } from '../people/repository.ts'
import * as pipelineRepository from '../pipelines/repository.ts'
import '../positions/events.ts'
import * as positionRepository from '../positions/repository.ts'
import * as workspaceRepository from '../workspace/repository.ts'
import './events.ts'
import {
  DEAL_CLOSE_HORIZON_DAYS,
  companyNameFrom,
  describeAnswers,
  expandDealNameTemplate,
  expectedCloseFrom,
  fillBlank,
  findAnswerProblems,
  mapAnswers,
  readIntent,
} from './mapping.ts'
import type { Answers, SubmitIntent } from './mapping.ts'
import * as repository from './repository.ts'
import type { FormFieldRecord, FormRecord } from './repository.ts'

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
  readonly submittedAt: Date
  /** Echoed so an embed can render it without a second request. */
  readonly thankYouMessage: string
}

export interface FormSubmitService {
  /** @throws AppError 404 unknown key, 409 paused, 422 unusable answers. */
  submit(publicKey: string, answers: Answers): Promise<SubmitOutcome>
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
  readonly dealId: string | null
}

/**
 * One `record.created` per record this submit invented, and one
 * `record.updated` per record it filled a blank on.
 *
 * A submit that matched an existing person and changed nothing about them emits
 * neither: a consumer mirroring the CRM has nothing to mirror, and
 * `form.submitted` already says the submission happened.
 *
 * The Deal has no `Upserted` because it is only ever created, and its people
 * link rides along with it rather than as a separate `record.updated`, the same
 * way the deals service treats a create.
 */
function emitRecordEvents(
  events: BufferedEvents,
  workspaceId: string,
  touched: TouchedRecords,
): void {
  if (touched.person !== undefined) {
    emitUpsertEvent(events, 'person', touched.person)
  }
  if (touched.company !== undefined) {
    emitUpsertEvent(events, 'company', touched.company)
  }
  if (touched.position !== undefined) {
    emitUpsertEvent(events, 'position', touched.position)
  }

  if (touched.dealId !== null) {
    events.emit('deals.deal.created', { type: 'deal', id: touched.dealId }, {})
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
      const created = await peopleRepository.insertPerson(tx, {
        id: dependencies.createId('person'),
        workspaceId,
        name: intent.personName,
        email: intent.email,
        lastContactedAt: now,
        ...NEW_PERSON_DEFAULTS,
      })

      return { record: created, created: true, filled: [] }
    }

    const name = fillBlank(existing.name, intent.personName)
    const updated = await peopleRepository.updatePerson(tx, workspaceId, existing.id, {
      ...(name === undefined ? {} : { name }),
      lastContactedAt: now,
      updatedAt: now,
    })

    if (updated === undefined) {
      throw new Error(`Person ${existing.id} disappeared during a form submit`)
    }

    return { record: updated, created: false, filled: name === undefined ? [] : ['name'] }
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

  /** The stage a form's deals open in: the one it names, or the pipeline's first open one. */
  async function openingStageId(
    tx: Transaction,
    workspaceId: string,
    form: FormRecord,
  ): Promise<string> {
    if (form.dealStageId !== null) {
      return form.dealStageId
    }

    const stages = await pipelineRepository.listStagesOfKind(tx, workspaceId, 'deal')
    const first = stages.find((stage) => stage.open) ?? stages[0]

    if (first === undefined) {
      // Unreachable through the API: a workspace seeds its stages at creation
      // and the last stage of a pipeline cannot be removed.
      throw AppError.conflict('This workspace has no deal stages')
    }

    return first.id
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
        expandDealNameTemplate(form.dealNameTemplate ?? DEFAULT_DEAL_NAME_TEMPLATE, {
          companyName: company.name,
          personName: intent.personName,
        }),
      companyId: company.id,
      stageId: await openingStageId(tx, workspaceId, form),
      valueCents: 0,
      currency: null,
      ownerId: owner?.id ?? null,
      expectedClose: expectedCloseFrom(dependencies.now(), DEAL_CLOSE_HORIZON_DAYS),
    })

    await dealRepository.insertDealPeople(tx, id, [personId])

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

  return {
    async submit(publicKey, answers) {
      const form = await requireOpenForm(publicKey)
      const { workspaceId } = form
      const fields = await repository.listFields(dependencies.db, form.id)
      const intent = readAnswers(fields, answers)

      return dependencies.transaction(async ({ tx, events }) => {
        const person = await upsertPerson(tx, workspaceId, intent)
        const company = await upsertCompany(tx, workspaceId, intent)
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
        const dealId =
          form.createDeal && company !== undefined
            ? await createDeal(tx, workspaceId, form, intent, company.record, person.record.id)
            : null

        const submission = await repository.insertSubmission(tx, {
          id: dependencies.createId('formSubmission'),
          workspaceId,
          formId: form.id,
          answers,
          personId: person.record.id,
          companyId: company?.record.id ?? null,
          positionId: position?.record.id ?? null,
          dealId,
          submittedAt: dependencies.now(),
        })

        await dependencies.recordActivity(tx, workspaceId, FORM_ACTOR, {
          targetType: 'person',
          targetId: person.record.id,
          kind: 'created',
          ...describeFormSubmission(form.name, describeAnswers(fields, answers)),
        })

        if (dealId !== null) {
          await dependencies.recordActivity(tx, workspaceId, FORM_ACTOR, {
            targetType: 'deal',
            targetId: dealId,
            kind: 'created',
            ...describeCreationVia('Deal', form.name),
          })
        }

        emitRecordEvents(events, workspaceId, { person, company, position, dealId })
        events.emit(
          'forms.submission.submitted',
          { type: 'submission', id: submission.id },
          { formId: form.id, submissionId: submission.id },
        )

        return {
          submissionId: submission.id,
          formId: form.id,
          personId: person.record.id,
          companyId: company?.record.id ?? null,
          positionId: position?.record.id ?? null,
          dealId,
          submittedAt: submission.submittedAt,
          thankYouMessage: form.thankYouMessage,
        }
      }, { workspaceId })
    },
  }
}
