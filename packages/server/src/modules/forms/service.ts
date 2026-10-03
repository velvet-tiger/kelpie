import type { CustomFieldDefinitionRef, CustomFieldObjectType, CustomFieldType } from '@kelpie/schemas'
import type {
  FormAttachTarget,
  FormEmailKind,
  FormEmailRecipient,
  FormSubmissionLinkTarget,
  FormSubmissionStatus,
  PipelineKind,
} from '@kelpie/schemas'
import {
  FORM_ATTACH_TARGET_TYPES,
  FORM_EMAIL_MAX_RECIPIENTS,
  findTemplatePlaceholderProblems,
} from '@kelpie/schemas'

import { changedKeys } from '../../lib/changes.ts'
import type { Database } from '../../lib/database.ts'
import { AppError } from '../../lib/errors.ts'
import type { IdFactory } from '../../lib/ids.ts'
import { mapPage, readListWindow, toPage } from '../../lib/pagination.ts'
import type { ListQueryParameters, Page } from '../../lib/pagination.ts'
import { UNIQUE_VIOLATION, postgresErrorCode } from '../../lib/database.ts'
import type { Transaction, TransactionScope } from '../../runtime/transaction.ts'
import { toEventActor } from '../../lib/actor.ts'
import type { Actor } from '../auth/actor.ts'
import { requireWorkspaceId } from '../auth/actor.ts'
import './events.ts'
import * as consentPurposesRepository from '../consent-purposes/repository.ts'
import * as customFieldsRepository from '../custom-fields/repository.ts'
import { CUSTOM_FIELD_OBJECT_TYPES } from '../custom-fields/schema.ts'
import * as listsRepository from '../lists/repository.ts'
import * as pipelineRepository from '../pipelines/repository.ts'
import * as workspaceRepository from '../workspace/repository.ts'
import { missingTargets } from '../recordTargets.ts'
import { fieldsDiffer, findFieldProblems, storedOptions } from './fields.ts'
import type { FieldDraft, FieldShape } from './fields.ts'
import * as emailRepository from './emailRepository.ts'
import { replyToFrom } from './emailMessages.ts'
import * as repository from './repository.ts'
import {
  DEFAULT_FORM_SORT,
  DEFAULT_FORM_SUBMISSION_SORT,
  FORM_SORTS,
  FORM_SUBMISSION_SORTS,
} from './repository.ts'
import type {
  FormFieldRecord,
  FormFilters,
  FormRecord,
  FormSubmissionRecord,
} from './repository.ts'
import type { FormStatus } from './schema.ts'

/**
 * Managing forms: the authenticated half.
 *
 * A form is returned with its fields nested, and written the same way. Fields
 * are not their own resource: a form without them cannot be rendered or
 * validated, and their order belongs to the form rather than to any one field.
 * A write replaces the whole list, which is also what a drag-reorder sends.
 */

export interface FormsDependencies {
  readonly db: Database
  readonly transaction: TransactionScope
  readonly createId: IdFactory
  readonly now: () => Date
  /** Injected so a test can pin a generated `slug`. */
  readonly generateSlug?: () => string
}

/**
 * A form as the API returns one: the stored row minus tenancy, with its
 * fields, its list memberships, its attach targets, and its notification
 * recipients. `list_ids`, `attach_targets` and `notify_recipients` are not
 * columns of `forms` — they live in the joined `form_lists` /
 * `form_attach_targets` / `form_notify_recipients` tables — but they cross the
 * wire nested under the form to keep write and read shapes symmetric. The two
 * Reply-To columns cross as one `auto_reply_reply_to` recipient.
 */
export type FormView = Omit<
  FormRecord,
  'workspaceId' | 'autoReplyReplyToMemberId' | 'autoReplyReplyToAddress'
> & {
  readonly fields: readonly FormFieldView[]
  readonly listIds: readonly string[]
  readonly attachTargets: readonly FormAttachTarget[]
  readonly notifyRecipients: readonly FormEmailRecipient[]
  readonly autoReplyReplyTo: FormEmailRecipient | null
}

export type FormFieldView = Omit<FormFieldRecord, 'workspaceId' | 'formId'>

export type FormSubmissionView = Omit<FormSubmissionRecord, 'workspaceId'>

export interface CreateFormInput {
  readonly name: string
  readonly title: string
  /** Null generates a random slug. */
  readonly slug: string | null
  readonly description: string | null
  readonly status: FormStatus
  readonly fields: readonly FieldDraft[]
  readonly thankYouMessage: string
  readonly createDeal: boolean
  readonly dealStageId: string | null
  readonly dealNameTemplate: string | null
  readonly createOpportunity: boolean
  readonly opportunityKind: string | null
  readonly opportunityStageId: string | null
  readonly opportunityNameTemplate: string | null
  readonly opportunityOwnerId: string | null
  readonly createPartnership: boolean
  readonly partnershipKind: string | null
  readonly partnershipStageId: string | null
  readonly partnershipNameTemplate: string | null
  readonly partnershipOwnerId: string | null
  readonly createEnquiry: boolean
  readonly enquirySource: string | null
  readonly enquiryStageId: string | null
  readonly enquiryNameTemplate: string | null
  readonly enquiryOwnerId: string | null
  readonly personTags: readonly string[]
  readonly companyTags: readonly string[]
  readonly listIds: readonly string[]
  readonly attachTargets: readonly FormAttachTarget[]
  readonly notifyEmail: boolean
  /** Addresses arrive trimmed and lowercased from the route. */
  readonly notifyRecipients: readonly FormEmailRecipient[]
  readonly notifySubject: string
  readonly notifyBody: string
  readonly autoReply: boolean
  readonly autoReplySubject: string
  readonly autoReplyBody: string
  readonly autoReplyReplyTo: FormEmailRecipient | null
  readonly requireSpamCheck: boolean
}

/** PATCH semantics: an absent field is left alone, and null clears a nullable one. */
export interface UpdateFormInput {
  readonly name?: string | undefined
  readonly title?: string | undefined
  readonly slug?: string | undefined
  readonly description?: string | null | undefined
  readonly status?: FormStatus | undefined
  /** Absent leaves the field list alone. Present replaces all of it. */
  readonly fields?: readonly FieldDraft[] | undefined
  readonly thankYouMessage?: string | undefined
  readonly createDeal?: boolean | undefined
  readonly dealStageId?: string | null | undefined
  readonly dealNameTemplate?: string | null | undefined
  readonly createOpportunity?: boolean | undefined
  readonly opportunityKind?: string | null | undefined
  readonly opportunityStageId?: string | null | undefined
  readonly opportunityNameTemplate?: string | null | undefined
  readonly opportunityOwnerId?: string | null | undefined
  readonly createPartnership?: boolean | undefined
  readonly partnershipKind?: string | null | undefined
  readonly partnershipStageId?: string | null | undefined
  readonly partnershipNameTemplate?: string | null | undefined
  readonly partnershipOwnerId?: string | null | undefined
  readonly createEnquiry?: boolean | undefined
  readonly enquirySource?: string | null | undefined
  readonly enquiryStageId?: string | null | undefined
  readonly enquiryNameTemplate?: string | null | undefined
  readonly enquiryOwnerId?: string | null | undefined
  readonly personTags?: readonly string[] | undefined
  readonly companyTags?: readonly string[] | undefined
  /** Absent leaves list memberships alone. Present replaces the whole set. */
  readonly listIds?: readonly string[] | undefined
  /** Absent leaves attach targets alone. Present replaces the whole set. */
  readonly attachTargets?: readonly FormAttachTarget[] | undefined
  readonly notifyEmail?: boolean | undefined
  /** Absent leaves the recipients alone. Present replaces the whole list. */
  readonly notifyRecipients?: readonly FormEmailRecipient[] | undefined
  readonly notifySubject?: string | undefined
  readonly notifyBody?: string | undefined
  readonly autoReply?: boolean | undefined
  readonly autoReplySubject?: string | undefined
  readonly autoReplyBody?: string | undefined
  /** Null clears the Reply-To. */
  readonly autoReplyReplyTo?: FormEmailRecipient | null | undefined
  readonly requireSpamCheck?: boolean | undefined
}

export interface FormsService {
  list(actor: Actor, filters: FormFilters, query: ListQueryParameters): Promise<Page<FormView>>
  get(actor: Actor, id: string): Promise<FormView>
  create(actor: Actor, input: CreateFormInput): Promise<FormView>
  update(actor: Actor, id: string, changes: UpdateFormInput): Promise<FormView>
  /** Replaces the slug with a new random one. Every existing embed stops working. */
  regenerateSlug(actor: Actor, id: string): Promise<FormView>
  remove(actor: Actor, id: string): Promise<void>
  /** One status at a time: what arrived (`accepted`), or what the spam check held (`spam`). */
  listSubmissions(
    actor: Actor,
    formId: string,
    status: FormSubmissionStatus,
    query: ListQueryParameters,
  ): Promise<Page<FormSubmissionView>>
  listSubmissionsLinkedTo(
    actor: Actor,
    target: FormSubmissionLinkTarget,
    targetId: string,
    query: ListQueryParameters,
  ): Promise<Page<FormSubmissionView>>
  getSubmission(actor: Actor, formId: string, submissionId: string): Promise<FormSubmissionView>
  /** Deletes one submission of either status. The records it linked stay. */
  removeSubmission(actor: Actor, formId: string, submissionId: string): Promise<void>
  /**
   * Deletes several submissions of one form. An id that is not one of the
   * form's submissions is skipped.
   *
   * @returns The ids that were deleted.
   */
  removeSubmissions(
    actor: Actor,
    formId: string,
    submissionIds: readonly string[],
  ): Promise<readonly string[]>
}

function toFieldView(record: FormFieldRecord): FormFieldView {
  const { workspaceId: _workspaceId, formId: _formId, ...view } = record

  return view
}

function toView(
  record: FormRecord,
  fields: readonly FormFieldRecord[],
  listIds: readonly string[],
  attachTargets: readonly FormAttachTarget[],
  notifyRecipients: readonly FormEmailRecipient[],
): FormView {
  const {
    workspaceId: _workspaceId,
    autoReplyReplyToMemberId,
    autoReplyReplyToAddress,
    ...view
  } = record

  return {
    ...view,
    fields: fields.map(toFieldView),
    listIds,
    attachTargets,
    notifyRecipients,
    autoReplyReplyTo: replyToFrom(autoReplyReplyToMemberId, autoReplyReplyToAddress),
  }
}

/** One recipient as the two Reply-To columns. Null clears both. */
function replyToColumns(
  recipient: FormEmailRecipient | null,
): Pick<repository.FormColumns, 'autoReplyReplyToMemberId' | 'autoReplyReplyToAddress'> {
  return {
    autoReplyReplyToMemberId: recipient?.kind === 'member' ? recipient.memberId : null,
    autoReplyReplyToAddress: recipient?.kind === 'address' ? recipient.address : null,
  }
}

function toSubmissionView(record: FormSubmissionRecord): FormSubmissionView {
  const { workspaceId: _workspaceId, ...view } = record

  return view
}

function toStoredColumns(input: UpdateFormInput): Partial<repository.FormColumns> {
  return {
    ...(input.name === undefined ? {} : { name: input.name }),
    ...(input.title === undefined ? {} : { title: input.title }),
    ...(input.slug === undefined ? {} : { slug: input.slug }),
    ...(input.description === undefined ? {} : { description: input.description }),
    ...(input.status === undefined ? {} : { status: input.status }),
    ...(input.thankYouMessage === undefined ? {} : { thankYouMessage: input.thankYouMessage }),
    ...(input.createDeal === undefined ? {} : { createDeal: input.createDeal }),
    ...(input.dealStageId === undefined ? {} : { dealStageId: input.dealStageId }),
    ...(input.dealNameTemplate === undefined ? {} : { dealNameTemplate: input.dealNameTemplate }),
    ...(input.createOpportunity === undefined
      ? {}
      : { createOpportunity: input.createOpportunity }),
    ...(input.opportunityKind === undefined ? {} : { opportunityKind: input.opportunityKind }),
    ...(input.opportunityStageId === undefined
      ? {}
      : { opportunityStageId: input.opportunityStageId }),
    ...(input.opportunityNameTemplate === undefined
      ? {}
      : { opportunityNameTemplate: input.opportunityNameTemplate }),
    ...(input.opportunityOwnerId === undefined
      ? {}
      : { opportunityOwnerId: input.opportunityOwnerId }),
    ...(input.createPartnership === undefined
      ? {}
      : { createPartnership: input.createPartnership }),
    ...(input.partnershipKind === undefined ? {} : { partnershipKind: input.partnershipKind }),
    ...(input.partnershipStageId === undefined
      ? {}
      : { partnershipStageId: input.partnershipStageId }),
    ...(input.partnershipNameTemplate === undefined
      ? {}
      : { partnershipNameTemplate: input.partnershipNameTemplate }),
    ...(input.partnershipOwnerId === undefined
      ? {}
      : { partnershipOwnerId: input.partnershipOwnerId }),
    ...(input.createEnquiry === undefined ? {} : { createEnquiry: input.createEnquiry }),
    ...(input.enquirySource === undefined ? {} : { enquirySource: input.enquirySource }),
    ...(input.enquiryStageId === undefined ? {} : { enquiryStageId: input.enquiryStageId }),
    ...(input.enquiryNameTemplate === undefined
      ? {}
      : { enquiryNameTemplate: input.enquiryNameTemplate }),
    ...(input.enquiryOwnerId === undefined ? {} : { enquiryOwnerId: input.enquiryOwnerId }),
    ...(input.personTags === undefined ? {} : { personTags: [...input.personTags] }),
    ...(input.companyTags === undefined ? {} : { companyTags: [...input.companyTags] }),
    ...(input.notifyEmail === undefined ? {} : { notifyEmail: input.notifyEmail }),
    ...(input.notifySubject === undefined ? {} : { notifySubject: input.notifySubject }),
    ...(input.notifyBody === undefined ? {} : { notifyBody: input.notifyBody }),
    ...(input.autoReply === undefined ? {} : { autoReply: input.autoReply }),
    ...(input.autoReplySubject === undefined ? {} : { autoReplySubject: input.autoReplySubject }),
    ...(input.autoReplyBody === undefined ? {} : { autoReplyBody: input.autoReplyBody }),
    ...(input.autoReplyReplyTo === undefined ? {} : replyToColumns(input.autoReplyReplyTo)),
    ...(input.requireSpamCheck === undefined ? {} : { requireSpamCheck: input.requireSpamCheck }),
  }
}

/** Where the resulting-state validation puts its answers. */
interface ResultingState {
  readonly fields: readonly FieldShape[]
  readonly createDeal: boolean
  readonly createOpportunity: boolean
  readonly opportunityKind: string | null
  readonly createPartnership: boolean
  readonly partnershipKind: string | null
  readonly listIds: readonly string[]
  readonly attachTargets: readonly FormAttachTarget[]
  readonly email: EmailSettingsState
}

/** The email settings a form write would leave behind. */
interface EmailSettingsState {
  readonly notifyEmail: boolean
  readonly notifyRecipients: readonly FormEmailRecipient[]
  readonly notifySubject: string
  readonly notifyBody: string
  readonly autoReply: boolean
  readonly autoReplySubject: string
  readonly autoReplyBody: string
  readonly autoReplyReplyTo: FormEmailRecipient | null
}

/** Order matters: it is the order the builder shows. */
function sameRecipients(
  current: readonly FormEmailRecipient[],
  next: readonly FormEmailRecipient[],
): boolean {
  return JSON.stringify(current) === JSON.stringify(next)
}

/**
 * Problems with the templates and the on/off rules, which need no query. A
 * template is checked while its email is off too: it is kept, and turning the
 * email on later must not find it unusable.
 */
function findEmailSettingProblems(state: EmailSettingsState): { field: string; message: string }[] {
  const problems: { field: string; message: string }[] = []
  const templates: readonly {
    readonly field: string
    readonly kind: FormEmailKind
    readonly on: boolean
    readonly text: string
  }[] = [
    { field: 'notify_subject', kind: 'notification', on: state.notifyEmail, text: state.notifySubject },
    { field: 'notify_body', kind: 'notification', on: state.notifyEmail, text: state.notifyBody },
    { field: 'auto_reply_subject', kind: 'auto_reply', on: state.autoReply, text: state.autoReplySubject },
    { field: 'auto_reply_body', kind: 'auto_reply', on: state.autoReply, text: state.autoReplyBody },
  ]

  for (const template of templates) {
    if (template.on && template.text.trim().length === 0) {
      problems.push({ field: template.field, message: 'Required while this email is on' })
    }

    for (const message of findTemplatePlaceholderProblems(template.text, template.kind)) {
      problems.push({ field: template.field, message })
    }
  }

  if (state.notifyEmail && state.notifyRecipients.length === 0) {
    problems.push({ field: 'notify_recipients', message: 'Add at least one recipient' })
  }

  if (state.notifyRecipients.length > FORM_EMAIL_MAX_RECIPIENTS) {
    problems.push({
      field: 'notify_recipients',
      message: `Name at most ${String(FORM_EMAIL_MAX_RECIPIENTS)} recipients`,
    })
  }

  return problems
}

/** Sorts an attach-target list so a resent identical set is not a write. */
function sortAttachTargets(
  targets: readonly FormAttachTarget[],
): readonly FormAttachTarget[] {
  return [...targets].sort((left, right) => {
    if (left.targetType !== right.targetType) {
      return left.targetType < right.targetType ? -1 : 1
    }

    return left.targetId < right.targetId ? -1 : left.targetId > right.targetId ? 1 : 0
  })
}

function sameStringSet(current: readonly string[], next: readonly string[]): boolean {
  if (current.length !== next.length) {
    return false
  }

  const currentSet = new Set(current)

  return next.every((value) => currentSet.has(value))
}

function sameAttachTargets(
  current: readonly FormAttachTarget[],
  next: readonly FormAttachTarget[],
): boolean {
  if (current.length !== next.length) {
    return false
  }

  const key = (target: FormAttachTarget): string => `${target.targetType}:${target.targetId}`
  const currentSet = new Set(current.map(key))

  return next.every((target) => currentSet.has(key(target)))
}

/**
 * A slug nobody chose: 12 characters, 60 bits. The slug is not a secret, so it
 * only has to be hard to guess. The alphabet has 32 letters, which divides 256,
 * so `byte % 32` has no bias. It leaves out `l`, `o`, `0` and `1`, which look
 * alike when a person reads a URL aloud.
 */
export function generateFormSlug(): string {
  const alphabet = 'abcdefghijkmnpqrstuvwxyz23456789'
  const bytes = crypto.getRandomValues(new Uint8Array(12))

  return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join('')
}

function duplicateSlug(): AppError {
  return AppError.conflict('Another form in this workspace already uses that slug', [
    { field: 'slug', message: 'Already in use' },
  ])
}

/** Answers a unique-slug violation with a 409 the UI can show on the field. */
async function refusingDuplicateSlug<T>(write: () => Promise<T>): Promise<T> {
  try {
    return await write()
  } catch (error) {
    if (postgresErrorCode(error) === UNIQUE_VIOLATION) {
      throw duplicateSlug()
    }

    throw error
  }
}

export function createFormsService(dependencies: FormsDependencies): FormsService {
  const generateSlug = dependencies.generateSlug ?? generateFormSlug

  async function require(workspaceId: string, id: string): Promise<FormRecord> {
    const form = await repository.findForm(dependencies.db, workspaceId, id)

    // A form in another workspace is indistinguishable from one that never
    // existed.
    if (form === undefined) {
      throw AppError.notFound('Form not found')
    }

    return form
  }

  /**
   * A stage a form's created records of `kind` may open in: in this workspace,
   * and in the matching pipeline.
   *
   * The wrong-workspace case reads as missing. The wrong-pipeline
   * case is a request naming a real stage that can never hold a record of
   * `kind`, which is a validation error rather than a missing record. Same rule
   * the deals service applies to `stage_id`.
   *
   * @param field The body-field name (`deal_stage_id`, `opportunity_stage_id`,
   *   `partnership_stage_id`) that the 422 detail should point at.
   */
  async function requireStageOfKind(
    workspaceId: string,
    kind: PipelineKind,
    stageId: string,
    field: string,
  ): Promise<void> {
    const stage = await pipelineRepository.findStage(dependencies.db, workspaceId, stageId)

    if (stage === undefined) {
      throw AppError.notFound('Pipeline stage not found')
    }

    if (stage.kind !== kind) {
      throw AppError.validationFailed(`That stage is not part of the ${kind} pipeline`, [
        { field, message: `It belongs to the ${stage.kind} pipeline` },
      ])
    }
  }

  /**
   * @throws AppError 422 listing every problem with the field list at once.
   */
  async function requireUsableFields(
    workspaceId: string,
    fields: readonly FieldShape[],
    createsDeal: boolean,
    createsPartnership: boolean,
  ): Promise<void> {
    const customFieldDefinitions = await loadCustomFieldDefinitions(workspaceId)
    const problems = findFieldProblems(fields, createsDeal, {
      createsPartnership,
      customFieldDefinitions,
    })

    if (problems.length > 0) {
      throw AppError.validationFailed('That field list cannot process a submission', problems)
    }
  }

  async function loadCustomFieldDefinitions(
    workspaceId: string,
  ): Promise<readonly CustomFieldDefinitionRef[]> {
    const rows = await Promise.all(
      CUSTOM_FIELD_OBJECT_TYPES.map((objectType) =>
        customFieldsRepository.definitionsForObject(dependencies.db, workspaceId, objectType),
      ),
    )

    return rows.flat().map(
      (row): CustomFieldDefinitionRef => ({
        objectType: row.objectType as CustomFieldObjectType,
        key: row.key,
        label: row.label,
        type: row.type as CustomFieldType,
      }),
    )
  }

  /**
   * The lists a form feeds — its action `list_ids` and the lists its "Add to
   * list" fields offer — must exist in this workspace and target `person` or
   * `company`. A list of another target type would never receive a submitter
   * or a company — a form only knows how to feed those two — so accepting it
   * would misdirect the visitor's inbound landing.
   */
  async function requireFormLists(
    workspaceId: string,
    listIds: readonly string[],
    fields: readonly FieldShape[],
  ): Promise<void> {
    const entries = [
      ...listIds.map((listId, index) => ({ listId, at: `list_ids.${String(index)}` })),
      ...fields.flatMap((field, fieldIndex) =>
        field.listIds.map((listId) => ({ listId, at: `fields.${String(fieldIndex)}.list_ids` })),
      ),
    ]

    if (entries.length === 0) {
      return
    }

    const ids = Array.from(new Set(entries.map((entry) => entry.listId)))
    const rows = await listsRepository.listListsById(dependencies.db, workspaceId, ids)
    const found = new Map(rows.map((row) => [row.id, row.targetType]))
    const problems = entries
      .map(({ listId, at }) => {
        const targetType = found.get(listId)

        if (targetType === undefined) {
          return { field: at, message: `No list ${listId} here` }
        }

        if (targetType !== 'person' && targetType !== 'company') {
          return {
            field: at,
            message: `A list feeding a form must target person or company (got ${targetType})`,
          }
        }

        return undefined
      })
      .filter((problem): problem is NonNullable<typeof problem> => problem !== undefined)

    if (problems.length > 0) {
      throw AppError.validationFailed(`Some lists cannot receive a submission`, problems)
    }
  }

  /**
   * Every attach target must exist in this workspace. Same `missingTargets`
   * check notes and list members use, grouped per type so one query per
   * pipeline kind resolves the whole set instead of one per row.
   */
  async function requireAttachTargets(
    workspaceId: string,
    targets: readonly FormAttachTarget[],
  ): Promise<void> {
    if (targets.length === 0) {
      return
    }

    const problems: { field: string; message: string }[] = []

    for (const kind of FORM_ATTACH_TARGET_TYPES) {
      const ofKind = targets.filter((target) => target.targetType === kind)

      if (ofKind.length === 0) {
        continue
      }

      const missing = await missingTargets(
        dependencies.db,
        workspaceId,
        kind,
        ofKind.map((target) => target.targetId),
      )

      if (missing.length === 0) {
        continue
      }

      const missingSet = new Set(missing)

      targets.forEach((target, index) => {
        if (target.targetType === kind && missingSet.has(target.targetId)) {
          problems.push({
            field: `attach_targets.${String(index)}`,
            message: `No ${kind} ${target.targetId} here`,
          })
        }
      })
    }

    if (problems.length > 0) {
      throw new AppError('not_found', 'Attach target not found', problems)
    }
  }

  /**
   * Every consent field's `consent_purpose_id` must exist in this workspace.
   * The FK on `form_fields.consent_purpose_id` catches this at the database
   * on write; running the check here first turns the failure into a 422 with
   * the offending field pinpointed instead of a foreign-key 500.
   */
  async function requireConsentPurposes(
    workspaceId: string,
    fields: readonly FieldShape[],
  ): Promise<void> {
    const consentIds = Array.from(
      new Set(fields.flatMap((field) => [...field.consentPurposeIds])),
    )
    if (consentIds.length === 0) return

    const rows = await consentPurposesRepository.listPurposesByIds(
      dependencies.db,
      workspaceId,
      consentIds,
    )
    const found = new Set(rows.map((row) => row.id))
    const problems: { field: string; message: string }[] = []
    fields.forEach((field, index) => {
      for (const purposeId of field.consentPurposeIds) {
        if (!found.has(purposeId)) {
          problems.push({
            field: `fields.${String(index)}.consent_purpose_ids`,
            message: `No consent purpose ${purposeId} in this workspace`,
          })
        }
      }
    })
    if (problems.length > 0) {
      throw AppError.validationFailed(
        'One or more consent fields name a purpose that does not exist',
        problems,
      )
    }
  }

  /**
   * The email settings a write would leave behind. Every member named as a
   * recipient or as the Reply-To must be a member of this workspace; the
   * foreign key would refuse another workspace's member only as a 500, and
   * would not refuse it at all when the id is real.
   */
  async function requireEmailSettings(workspaceId: string, state: EmailSettingsState): Promise<void> {
    const problems = findEmailSettingProblems(state)
    const memberEntries = [
      ...state.notifyRecipients.map((recipient, index) => ({
        recipient,
        at: `notify_recipients.${String(index)}`,
      })),
      ...(state.autoReplyReplyTo === null
        ? []
        : [{ recipient: state.autoReplyReplyTo, at: 'auto_reply_reply_to' }]),
    ].filter((entry) => entry.recipient.kind === 'member')

    if (memberEntries.length > 0) {
      const members = new Set(
        (await workspaceRepository.listMembers(dependencies.db, workspaceId)).map((member) => member.id),
      )

      for (const { recipient, at } of memberEntries) {
        if (recipient.kind === 'member' && !members.has(recipient.memberId)) {
          problems.push({ field: at, message: `No member ${recipient.memberId} in this workspace` })
        }
      }
    }

    if (problems.length > 0) {
      throw AppError.validationFailed('The form emails cannot be sent as set', problems)
    }
  }

  /**
   * Resulting-state validation for everything except the three stage-id
   * checks: those depend on whether the id actually changed, which is only
   * known at the call site, so they stay inline in create() and update().
   */
  async function validateResultingState(
    workspaceId: string,
    state: ResultingState,
  ): Promise<void> {
    await requireUsableFields(workspaceId, state.fields, state.createDeal, state.createPartnership)
    await requireConsentPurposes(workspaceId, state.fields)
    await requireFormLists(workspaceId, state.listIds, state.fields)
    await requireAttachTargets(workspaceId, state.attachTargets)
    await requireEmailSettings(workspaceId, state.email)
  }

  /** Writes a field list as positions 0..n-1, which is the order it arrived in. */
  function writeFields(
    tx: Transaction,
    workspaceId: string,
    formId: string,
    fields: readonly FieldDraft[],
  ): Promise<FormFieldRecord[]> {
    return repository.insertFields(
      tx,
      fields.map((field, index) => ({
        id: dependencies.createId('formField'),
        workspaceId,
        formId,
        label: field.label,
        type: field.type,
        required: field.required,
        mapTo: field.mapTo,
        options: storedOptions(field.options),
        placeholder: field.placeholder,
        statement: field.statement,
        consentPurposeIds: [...field.consentPurposeIds],
        // Prune the override map to just the purposes the field lists, so
        // deselecting one clears its custom text rather than keeping it
        // stored against a purpose the field no longer offers.
        consentPurposeLabels: pruneLabels(field.consentPurposeIds, field.consentPurposeLabels),
        listIds: [...field.listIds],
        listLabels: pruneLabels(field.listIds, field.listLabels),
        sortOrder: index,
      })),
    )
  }

  function pruneLabels(
    ids: readonly string[],
    labels: Readonly<Record<string, string>>,
  ): Readonly<Record<string, string>> {
    const allowed = new Set(ids)
    const pruned: Record<string, string> = {}
    for (const [key, value] of Object.entries(labels)) {
      if (allowed.has(key) && value.length > 0) pruned[key] = value
    }
    return pruned
  }

  /** @returns The page's views, with every form's fields fetched in one query. */
  async function toViews(records: readonly FormRecord[]): Promise<FormView[]> {
    const fields = await repository.listFieldsFor(
      dependencies.db,
      records.map((record) => record.id),
    )

    const recipients = await emailRepository.listNotifyRecipientsFor(
      dependencies.db,
      records.map((record) => record.id),
    )

    // list_ids and attach_targets are per-form, so a list-page fetch takes them
    // in one round trip per form. In practice a list page is small (25 rows by
    // default), and the sets themselves are short.
    return Promise.all(
      records.map(async (record) => {
        const [listRows, attachTargets] = await Promise.all([
          repository.listFormLists(dependencies.db, record.id),
          repository.listAttachTargets(dependencies.db, record.id),
        ])

        return toView(
          record,
          fields.filter((field) => field.formId === record.id),
          listRows.map((row) => row.listId),
          attachTargets,
          recipients.get(record.id) ?? [],
        )
      }),
    )
  }

  async function hydrateOne(record: FormRecord): Promise<FormView> {
    const [fields, listRows, attachTargets, recipients] = await Promise.all([
      repository.listFields(dependencies.db, record.id),
      repository.listFormLists(dependencies.db, record.id),
      repository.listAttachTargets(dependencies.db, record.id),
      emailRepository.listNotifyRecipients(dependencies.db, record.id),
    ])

    return toView(
      record,
      fields,
      listRows.map((row) => row.listId),
      attachTargets,
      recipients,
    )
  }

  return {
    async list(actor, filters, query) {
      const workspaceId = requireWorkspaceId(actor)
      const window = readListWindow(query, FORM_SORTS, DEFAULT_FORM_SORT)
      const rows = await repository.listForms(dependencies.db, workspaceId, filters, window)
      const page = toPage(rows, window, (form) => form.id)

      return { items: await toViews(page.items), nextCursor: page.nextCursor }
    },

    async get(actor, id) {
      const workspaceId = requireWorkspaceId(actor)
      const form = await require(workspaceId, id)

      return hydrateOne(form)
    },

    async create(actor, input) {
      const workspaceId = requireWorkspaceId(actor)

      await validateResultingState(workspaceId, {
        fields: input.fields,
        createDeal: input.createDeal,
        createOpportunity: input.createOpportunity,
        opportunityKind: input.opportunityKind,
        createPartnership: input.createPartnership,
        partnershipKind: input.partnershipKind,
        listIds: input.listIds,
        attachTargets: input.attachTargets,
        email: {
          notifyEmail: input.notifyEmail,
          notifyRecipients: input.notifyRecipients,
          notifySubject: input.notifySubject,
          notifyBody: input.notifyBody,
          autoReply: input.autoReply,
          autoReplySubject: input.autoReplySubject,
          autoReplyBody: input.autoReplyBody,
          autoReplyReplyTo: input.autoReplyReplyTo,
        },
      })

      if (input.dealStageId !== null) {
        await requireStageOfKind(workspaceId, 'deal', input.dealStageId, 'deal_stage_id')
      }
      if (input.opportunityStageId !== null) {
        await requireStageOfKind(
          workspaceId,
          'opportunity',
          input.opportunityStageId,
          'opportunity_stage_id',
        )
      }
      if (input.partnershipStageId !== null) {
        await requireStageOfKind(
          workspaceId,
          'partnership',
          input.partnershipStageId,
          'partnership_stage_id',
        )
      }
      if (input.enquiryStageId !== null) {
        await requireStageOfKind(workspaceId, 'enquiry', input.enquiryStageId, 'enquiry_stage_id')
      }

      const id = dependencies.createId('form')
      const sortedAttachTargets = sortAttachTargets(input.attachTargets)

      return refusingDuplicateSlug(() => dependencies.transaction(async ({ tx, events }) => {
        const created = await repository.insertForm(tx, {
          id,
          workspaceId,
          name: input.name,
          title: input.title,
          description: input.description,
          status: input.status,
          thankYouMessage: input.thankYouMessage,
          createDeal: input.createDeal,
          dealStageId: input.dealStageId,
          dealNameTemplate: input.dealNameTemplate,
          createOpportunity: input.createOpportunity,
          opportunityKind: input.opportunityKind,
          opportunityStageId: input.opportunityStageId,
          opportunityNameTemplate: input.opportunityNameTemplate,
          opportunityOwnerId: input.opportunityOwnerId,
          createPartnership: input.createPartnership,
          partnershipKind: input.partnershipKind,
          partnershipStageId: input.partnershipStageId,
          partnershipNameTemplate: input.partnershipNameTemplate,
          partnershipOwnerId: input.partnershipOwnerId,
          createEnquiry: input.createEnquiry,
          enquirySource: input.enquirySource,
          enquiryStageId: input.enquiryStageId,
          enquiryNameTemplate: input.enquiryNameTemplate,
          enquiryOwnerId: input.enquiryOwnerId,
          personTags: [...input.personTags],
          companyTags: [...input.companyTags],
          notifyEmail: input.notifyEmail,
          notifySubject: input.notifySubject,
          notifyBody: input.notifyBody,
          autoReply: input.autoReply,
          autoReplySubject: input.autoReplySubject,
          autoReplyBody: input.autoReplyBody,
          ...replyToColumns(input.autoReplyReplyTo),
          requireSpamCheck: input.requireSpamCheck,
          slug: input.slug ?? generateSlug(),
        })
        const fields = await writeFields(tx, workspaceId, id, input.fields)
        await repository.replaceFormLists(tx, workspaceId, id, input.listIds)
        await repository.replaceAttachTargets(tx, workspaceId, id, sortedAttachTargets)
        await emailRepository.replaceNotifyRecipients(tx, workspaceId, id, input.notifyRecipients)

        events.emit('forms.form.created', { type: 'form', id }, {})

        return toView(
          created,
          fields,
          [...input.listIds],
          sortedAttachTargets,
          input.notifyRecipients,
        )
      }, { workspaceId, actor: toEventActor(actor) }))
    },

    async update(actor, id, changes) {
      const workspaceId = requireWorkspaceId(actor)
      const existing = await require(workspaceId, id)
      const stored = await repository.listFields(dependencies.db, id)
      const storedListRows = await repository.listFormLists(dependencies.db, id)
      const storedListIds = storedListRows.map((row) => row.listId)
      const storedAttachTargets = await repository.listAttachTargets(dependencies.db, id)
      const storedRecipients = await emailRepository.listNotifyRecipients(dependencies.db, id)

      const nextListIds = changes.listIds ?? storedListIds
      const nextAttachTargets = sortAttachTargets(changes.attachTargets ?? storedAttachTargets)
      const nextRecipients = changes.notifyRecipients ?? storedRecipients

      // Validated against the state the request would leave behind, not against
      // what it carried. Turning `create_deal` on is what makes a form with no
      // company mapping unusable, and that request names no fields at all.
      await validateResultingState(workspaceId, {
        fields: changes.fields ?? stored,
        createDeal: changes.createDeal ?? existing.createDeal,
        createOpportunity: changes.createOpportunity ?? existing.createOpportunity,
        opportunityKind:
          changes.opportunityKind === undefined
            ? existing.opportunityKind
            : changes.opportunityKind,
        createPartnership: changes.createPartnership ?? existing.createPartnership,
        partnershipKind:
          changes.partnershipKind === undefined
            ? existing.partnershipKind
            : changes.partnershipKind,
        listIds: nextListIds,
        attachTargets: nextAttachTargets,
        email: {
          notifyEmail: changes.notifyEmail ?? existing.notifyEmail,
          notifyRecipients: nextRecipients,
          notifySubject: changes.notifySubject ?? existing.notifySubject,
          notifyBody: changes.notifyBody ?? existing.notifyBody,
          autoReply: changes.autoReply ?? existing.autoReply,
          autoReplySubject: changes.autoReplySubject ?? existing.autoReplySubject,
          autoReplyBody: changes.autoReplyBody ?? existing.autoReplyBody,
          autoReplyReplyTo:
            changes.autoReplyReplyTo === undefined
              ? replyToFrom(existing.autoReplyReplyToMemberId, existing.autoReplyReplyToAddress)
              : changes.autoReplyReplyTo,
        },
      })

      if (typeof changes.dealStageId === 'string' && changes.dealStageId !== existing.dealStageId) {
        await requireStageOfKind(workspaceId, 'deal', changes.dealStageId, 'deal_stage_id')
      }
      if (
        typeof changes.opportunityStageId === 'string' &&
        changes.opportunityStageId !== existing.opportunityStageId
      ) {
        await requireStageOfKind(
          workspaceId,
          'opportunity',
          changes.opportunityStageId,
          'opportunity_stage_id',
        )
      }
      if (
        typeof changes.partnershipStageId === 'string' &&
        changes.partnershipStageId !== existing.partnershipStageId
      ) {
        await requireStageOfKind(
          workspaceId,
          'partnership',
          changes.partnershipStageId,
          'partnership_stage_id',
        )
      }
      if (
        typeof changes.enquiryStageId === 'string' &&
        changes.enquiryStageId !== existing.enquiryStageId
      ) {
        await requireStageOfKind(
          workspaceId,
          'enquiry',
          changes.enquiryStageId,
          'enquiry_stage_id',
        )
      }

      const columns = toStoredColumns(changes)
      const written = changedKeys(existing, columns)

      // A resent field list that matches what is stored is not a write. Rewriting
      // it would move every field id and publish a `record.updated` no consumer
      // can act on, which is the same reason `changedKeys` guards the columns.
      const rewritesFields = changes.fields !== undefined && fieldsDiffer(stored, changes.fields)
      const rewritesLists =
        changes.listIds !== undefined && !sameStringSet(storedListIds, changes.listIds)
      const rewritesAttachTargets =
        changes.attachTargets !== undefined &&
        !sameAttachTargets(storedAttachTargets, changes.attachTargets)
      const rewritesRecipients =
        changes.notifyRecipients !== undefined &&
        !sameRecipients(storedRecipients, changes.notifyRecipients)

      if (
        written.length === 0 &&
        !rewritesFields &&
        !rewritesLists &&
        !rewritesAttachTargets &&
        !rewritesRecipients
      ) {
        return toView(existing, stored, storedListIds, storedAttachTargets, storedRecipients)
      }

      return refusingDuplicateSlug(() => dependencies.transaction(async ({ tx, events }) => {
        // A changed field list, list set, or attach-target set is a change to
        // the form, so it stamps `updated_at` even when no column of the form
        // itself moved.
        const updated = await repository.updateForm(tx, workspaceId, id, {
          ...columns,
          updatedAt: dependencies.now(),
        })

        if (updated === undefined) {
          throw AppError.notFound('Form not found')
        }

        const fields = await (async (): Promise<FormFieldRecord[]> => {
          if (changes.fields === undefined || !rewritesFields) {
            return repository.listFields(tx, id)
          }

          await repository.deleteFields(tx, id)

          return writeFields(tx, workspaceId, id, changes.fields)
        })()

        if (rewritesLists) {
          await repository.replaceFormLists(tx, workspaceId, id, nextListIds)
        }
        if (rewritesAttachTargets) {
          await repository.replaceAttachTargets(tx, workspaceId, id, nextAttachTargets)
        }
        if (rewritesRecipients) {
          await emailRepository.replaceNotifyRecipients(tx, workspaceId, id, nextRecipients)
        }

        const changedFields: string[] = [...written]

        if (rewritesFields) {
          changedFields.push('fields')
        }
        if (rewritesLists) {
          changedFields.push('listIds')
        }
        if (rewritesAttachTargets) {
          changedFields.push('attachTargets')
        }
        if (rewritesRecipients) {
          changedFields.push('notifyRecipients')
        }

        events.emit('forms.form.updated', { type: 'form', id }, { changed: changedFields })

        return toView(updated, fields, nextListIds, nextAttachTargets, nextRecipients)
      }, { workspaceId, actor: toEventActor(actor) }))
    },

    async regenerateSlug(actor, id) {
      const workspaceId = requireWorkspaceId(actor)
      await require(workspaceId, id)

      return refusingDuplicateSlug(() => dependencies.transaction(async ({ tx, events }) => {
        const updated = await repository.updateForm(tx, workspaceId, id, {
          slug: generateSlug(),
          updatedAt: dependencies.now(),
        })

        if (updated === undefined) {
          throw AppError.notFound('Form not found')
        }

        const fields = await repository.listFields(tx, id)
        const listRows = await repository.listFormLists(tx, id)
        const attachTargets = await repository.listAttachTargets(tx, id)
        const recipients = await emailRepository.listNotifyRecipients(tx, id)

        events.emit('forms.form.updated', { type: 'form', id }, { changed: ['slug'] })

        return toView(
          updated,
          fields,
          listRows.map((row) => row.listId),
          attachTargets,
          recipients,
        )
      }, { workspaceId, actor: toEventActor(actor) }))
    },

    /**
     * Deletes the form, its fields, and its submissions.
     *
     * Submissions go with it: they are dependents of the form, and
     * the records a submission created are independent and stay. Their links
     * were already `set null` on the submission side, so nothing in the CRM
     * loses a reference.
     */
    async remove(actor, id) {
      const workspaceId = requireWorkspaceId(actor)

      await dependencies.transaction(async ({ tx, events }) => {
        const removed = await repository.deleteForm(tx, workspaceId, id)

        if (removed === 0) {
          throw AppError.notFound('Form not found')
        }

        events.emit('forms.form.deleted', { type: 'form', id }, {})
      }, { workspaceId, actor: toEventActor(actor) })
    },

    async listSubmissions(actor, formId, status, query) {
      const workspaceId = requireWorkspaceId(actor)

      // Checked rather than relying on the filter: a submissions list for a form
      // in another workspace must read as a missing form, not as an empty list.
      await require(workspaceId, formId)

      const window = readListWindow(query, FORM_SUBMISSION_SORTS, DEFAULT_FORM_SUBMISSION_SORT)
      const rows = await repository.listSubmissions(
        dependencies.db,
        workspaceId,
        formId,
        status,
        window,
      )

      return mapPage(
        toPage(rows, window, (submission) => submission.id),
        toSubmissionView,
      )
    },

    async listSubmissionsLinkedTo(actor, target, targetId, query) {
      const workspaceId = requireWorkspaceId(actor)

      // The target's existence is not checked here — a missing or cross-workspace
      // target reads as an empty page, the same answer any other cross-workspace
      // list returns. Adding a per-type existence check would need seven queries
      // for one behaviour that the FK filter already produces.
      const window = readListWindow(query, FORM_SUBMISSION_SORTS, DEFAULT_FORM_SUBMISSION_SORT)
      const rows = await repository.listSubmissionsLinkedTo(
        dependencies.db,
        workspaceId,
        target,
        targetId,
        window,
      )

      return mapPage(
        toPage(rows, window, (submission) => submission.id),
        toSubmissionView,
      )
    },

    async getSubmission(actor, formId, submissionId) {
      const workspaceId = requireWorkspaceId(actor)

      await require(workspaceId, formId)

      const row = await repository.findSubmission(
        dependencies.db,
        workspaceId,
        formId,
        submissionId,
      )

      if (row === undefined) {
        throw AppError.notFound('Submission not found')
      }

      return toSubmissionView(row)
    },

    async removeSubmission(actor, formId, submissionId) {
      const removed = await removeSubmissionsOf(actor, formId, [submissionId])

      if (removed.length === 0) {
        throw AppError.notFound('Submission not found')
      }
    },

    removeSubmissions(actor, formId, submissionIds) {
      return removeSubmissionsOf(actor, formId, submissionIds)
    },
  }

  /**
   * The delete under both submission removes.
   *
   * Only the submission rows go, with their email send log by cascade. The
   * records a submission created or matched are independent of it and stay,
   * as they do when the whole form is deleted.
   */
  async function removeSubmissionsOf(
    actor: Actor,
    formId: string,
    submissionIds: readonly string[],
  ): Promise<string[]> {
    const workspaceId = requireWorkspaceId(actor)

    // A form in another workspace reads as missing, not as a delete of nothing.
    await require(workspaceId, formId)

    return dependencies.transaction(async ({ tx, events }) => {
      const removed = await repository.deleteSubmissions(tx, workspaceId, formId, submissionIds)

      for (const id of removed) {
        events.emit('forms.submission.deleted', { type: 'submission', id }, { formId })
      }

      return removed
    }, { workspaceId, actor: toEventActor(actor) })
  }
}
