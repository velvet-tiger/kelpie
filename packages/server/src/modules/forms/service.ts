import type { FormAttachTarget, PipelineKind } from '@kelpie/schemas'
import { PIPELINE_KINDS } from '@kelpie/schemas'

import { changedKeys } from '../../lib/changes.ts'
import type { Database } from '../../lib/database.ts'
import { AppError } from '../../lib/errors.ts'
import type { IdFactory } from '../../lib/ids.ts'
import { mapPage, readListWindow, toPage } from '../../lib/pagination.ts'
import type { ListQueryParameters, Page } from '../../lib/pagination.ts'
import { generateToken } from '../../lib/tokens.ts'
import type { Transaction, TransactionScope } from '../../runtime/transaction.ts'
import { toEventActor } from '../../lib/actor.ts'
import type { Actor } from '../auth/actor.ts'
import { requireWorkspaceId } from '../auth/actor.ts'
import './events.ts'
import * as listsRepository from '../lists/repository.ts'
import * as pipelineRepository from '../pipelines/repository.ts'
import { missingTargets } from '../recordTargets.ts'
import { fieldsDiffer, findFieldProblems, storedOptions } from './fields.ts'
import type { FieldDraft, FieldShape } from './fields.ts'
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
 * Managing forms: the authenticated half of `forms.md`.
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
  /** Injected so a test can pin the generated `public_key`. */
  readonly generatePublicKey?: () => string
}

/**
 * A form as the API returns one: the stored row minus tenancy, with its
 * fields, its list memberships, and its attach targets. `list_ids` and
 * `attach_targets` are not columns of `forms` — they live in the joined
 * `form_lists` / `form_attach_targets` tables — but they cross the wire
 * nested under the form to keep write and read shapes symmetric.
 */
export type FormView = Omit<FormRecord, 'workspaceId'> & {
  readonly fields: readonly FormFieldView[]
  readonly listIds: readonly string[]
  readonly attachTargets: readonly FormAttachTarget[]
}

export type FormFieldView = Omit<FormFieldRecord, 'workspaceId' | 'formId'>

export type FormSubmissionView = Omit<FormSubmissionRecord, 'workspaceId'>

export interface CreateFormInput {
  readonly name: string
  readonly title: string
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
}

/** PATCH semantics: an absent field is left alone, and null clears a nullable one. */
export interface UpdateFormInput {
  readonly name?: string | undefined
  readonly title?: string | undefined
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
}

export interface FormsService {
  list(actor: Actor, filters: FormFilters, query: ListQueryParameters): Promise<Page<FormView>>
  get(actor: Actor, id: string): Promise<FormView>
  create(actor: Actor, input: CreateFormInput): Promise<FormView>
  update(actor: Actor, id: string, changes: UpdateFormInput): Promise<FormView>
  remove(actor: Actor, id: string): Promise<void>
  listSubmissions(
    actor: Actor,
    formId: string,
    query: ListQueryParameters,
  ): Promise<Page<FormSubmissionView>>
  getSubmission(actor: Actor, formId: string, submissionId: string): Promise<FormSubmissionView>
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
): FormView {
  const { workspaceId: _workspaceId, ...view } = record

  return { ...view, fields: fields.map(toFieldView), listIds, attachTargets }
}

function toSubmissionView(record: FormSubmissionRecord): FormSubmissionView {
  const { workspaceId: _workspaceId, ...view } = record

  return view
}

function toStoredColumns(input: UpdateFormInput): Partial<repository.FormColumns> {
  return {
    ...(input.name === undefined ? {} : { name: input.name }),
    ...(input.title === undefined ? {} : { title: input.title }),
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

export function createFormsService(dependencies: FormsDependencies): FormsService {
  const generatePublicKey = dependencies.generatePublicKey ?? generateToken

  async function require(workspaceId: string, id: string): Promise<FormRecord> {
    const form = await repository.findForm(dependencies.db, workspaceId, id)

    // A form in another workspace is indistinguishable from one that never
    // existed, per `api.md`.
    if (form === undefined) {
      throw AppError.notFound('Form not found')
    }

    return form
  }

  /**
   * A stage a form's created records of `kind` may open in: in this workspace,
   * and in the matching pipeline.
   *
   * The wrong-workspace case reads as missing, per `api.md`. The wrong-pipeline
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
  function requireUsableFields(
    fields: readonly FieldShape[],
    createsDeal: boolean,
    createsPartnership: boolean,
  ): void {
    const problems = findFieldProblems(fields, createsDeal, createsPartnership)

    if (problems.length > 0) {
      throw AppError.validationFailed('That field list cannot process a submission', problems)
    }
  }

  /**
   * Refuses a trigger whose `kind` is empty while the toggle is on. Kinds are
   * free text (no pipeline enum), so the only way to catch a misconfiguration
   * before submit time is at form write: the runner would otherwise store an
   * opportunity or partnership with an empty `kind`, which is a valid string
   * but not a valid opportunity/partnership.
   */
  function requireKindWhenCreating(
    createFlag: boolean,
    kind: string | null,
    field: string,
    trigger: string,
  ): void {
    if (createFlag && (kind === null || kind.trim().length === 0)) {
      throw AppError.validationFailed(`A form that creates ${trigger}s needs a kind`, [
        { field, message: `Set a kind when create_${trigger} is on` },
      ])
    }
  }

  /**
   * The lists an action-configured form names must exist in this workspace and
   * target `person` or `company`. A list of another target type would never
   * receive a submitter or a company — a form only knows how to feed those two
   * — so accepting it would misdirect the visitor's inbound landing.
   */
  async function requireActionLists(
    workspaceId: string,
    listIds: readonly string[],
  ): Promise<void> {
    if (listIds.length === 0) {
      return
    }

    const rows = await listsRepository.listListsById(dependencies.db, workspaceId, listIds)
    const found = new Map(rows.map((row) => [row.id, row.targetType]))
    const problems = listIds
      .map((listId, index) => {
        const targetType = found.get(listId)

        if (targetType === undefined) {
          return { field: `list_ids.${String(index)}`, message: `No list ${listId} here` }
        }

        if (targetType !== 'person' && targetType !== 'company') {
          return {
            field: `list_ids.${String(index)}`,
            message: `A list feeding a form must target person or company (got ${targetType})`,
          }
        }

        return undefined
      })
      .filter((problem): problem is NonNullable<typeof problem> => problem !== undefined)

    if (problems.length > 0) {
      throw AppError.validationFailed(`Some list_ids cannot receive a submission`, problems)
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

    for (const kind of PIPELINE_KINDS) {
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
   * Resulting-state validation for everything except the three stage-id
   * checks: those depend on whether the id actually changed, which is only
   * known at the call site, so they stay inline in create() and update().
   */
  async function validateResultingState(
    workspaceId: string,
    state: ResultingState,
  ): Promise<void> {
    requireUsableFields(state.fields, state.createDeal, state.createPartnership)
    requireKindWhenCreating(
      state.createOpportunity,
      state.opportunityKind,
      'opportunity_kind',
      'opportunity',
    )
    requireKindWhenCreating(
      state.createPartnership,
      state.partnershipKind,
      'partnership_kind',
      'partnership',
    )
    await requireActionLists(workspaceId, state.listIds)
    await requireAttachTargets(workspaceId, state.attachTargets)
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
        sortOrder: index,
      })),
    )
  }

  /** @returns The page's views, with every form's fields fetched in one query. */
  async function toViews(records: readonly FormRecord[]): Promise<FormView[]> {
    const fields = await repository.listFieldsFor(
      dependencies.db,
      records.map((record) => record.id),
    )

    // list_ids and attach_targets are per-form, so a list-page fetch takes them
    // in one round trip per form. In practice a list page is small (25 rows by
    // default, per api.md), and the sets themselves are short.
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
        )
      }),
    )
  }

  async function hydrateOne(record: FormRecord): Promise<FormView> {
    const [fields, listRows, attachTargets] = await Promise.all([
      repository.listFields(dependencies.db, record.id),
      repository.listFormLists(dependencies.db, record.id),
      repository.listAttachTargets(dependencies.db, record.id),
    ])

    return toView(
      record,
      fields,
      listRows.map((row) => row.listId),
      attachTargets,
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

      return dependencies.transaction(async ({ tx, events }) => {
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
          publicKey: generatePublicKey(),
        })
        const fields = await writeFields(tx, workspaceId, id, input.fields)
        await repository.replaceFormLists(tx, workspaceId, id, input.listIds)
        await repository.replaceAttachTargets(tx, workspaceId, id, sortedAttachTargets)

        events.emit('forms.form.created', { type: 'form', id }, {})

        return toView(created, fields, [...input.listIds], sortedAttachTargets)
      }, { workspaceId, actor: toEventActor(actor) })
    },

    async update(actor, id, changes) {
      const workspaceId = requireWorkspaceId(actor)
      const existing = await require(workspaceId, id)
      const stored = await repository.listFields(dependencies.db, id)
      const storedListRows = await repository.listFormLists(dependencies.db, id)
      const storedListIds = storedListRows.map((row) => row.listId)
      const storedAttachTargets = await repository.listAttachTargets(dependencies.db, id)

      const nextListIds = changes.listIds ?? storedListIds
      const nextAttachTargets = sortAttachTargets(changes.attachTargets ?? storedAttachTargets)

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

      if (
        written.length === 0 &&
        !rewritesFields &&
        !rewritesLists &&
        !rewritesAttachTargets
      ) {
        return toView(existing, stored, storedListIds, storedAttachTargets)
      }

      return dependencies.transaction(async ({ tx, events }) => {
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

        events.emit('forms.form.updated', { type: 'form', id }, { changed: changedFields })

        return toView(updated, fields, nextListIds, nextAttachTargets)
      }, { workspaceId, actor: toEventActor(actor) })
    },

    /**
     * Deletes the form, its fields, and its submissions.
     *
     * Submissions go with it: `schema.md` makes them dependents of the form, and
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

    async listSubmissions(actor, formId, query) {
      const workspaceId = requireWorkspaceId(actor)

      // Checked rather than relying on the filter: a submissions list for a form
      // in another workspace must read as a missing form, not as an empty list.
      await require(workspaceId, formId)

      const window = readListWindow(query, FORM_SUBMISSION_SORTS, DEFAULT_FORM_SUBMISSION_SORT)
      const rows = await repository.listSubmissions(dependencies.db, workspaceId, formId, window)

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
  }
}
