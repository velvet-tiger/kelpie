import { changedKeys } from '../../lib/changes.ts'
import type { Database } from '../../lib/database.ts'
import { AppError } from '../../lib/errors.ts'
import type { IdFactory } from '../../lib/ids.ts'
import { mapPage, readListWindow, toPage } from '../../lib/pagination.ts'
import type { ListQueryParameters, Page } from '../../lib/pagination.ts'
import { generateToken } from '../../lib/tokens.ts'
import type { Transaction, TransactionScope } from '../../runtime/transaction.ts'
import type { Actor } from '../auth/actor.ts'
import { requireWorkspaceId } from '../auth/actor.ts'
import * as pipelineRepository from '../pipelines/repository.ts'
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

/** A form as the API returns one: the stored row minus tenancy, with its fields. */
export type FormView = Omit<FormRecord, 'workspaceId'> & {
  readonly fields: readonly FormFieldView[]
}

export type FormFieldView = Omit<FormFieldRecord, 'workspaceId' | 'formId'>

export type FormSubmissionView = Omit<FormSubmissionRecord, 'workspaceId'>

export interface CreateFormInput {
  readonly name: string
  readonly description: string | null
  readonly status: FormStatus
  readonly fields: readonly FieldDraft[]
  readonly thankYouMessage: string
  readonly createDeal: boolean
  readonly dealStageId: string | null
  readonly dealNameTemplate: string | null
}

/** PATCH semantics: an absent field is left alone, and null clears a nullable one. */
export interface UpdateFormInput {
  readonly name?: string | undefined
  readonly description?: string | null | undefined
  readonly status?: FormStatus | undefined
  /** Absent leaves the field list alone. Present replaces all of it. */
  readonly fields?: readonly FieldDraft[] | undefined
  readonly thankYouMessage?: string | undefined
  readonly createDeal?: boolean | undefined
  readonly dealStageId?: string | null | undefined
  readonly dealNameTemplate?: string | null | undefined
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
}

function toFieldView(record: FormFieldRecord): FormFieldView {
  const { workspaceId: _workspaceId, formId: _formId, ...view } = record

  return view
}

function toView(record: FormRecord, fields: readonly FormFieldRecord[]): FormView {
  const { workspaceId: _workspaceId, ...view } = record

  return { ...view, fields: fields.map(toFieldView) }
}

function toSubmissionView(record: FormSubmissionRecord): FormSubmissionView {
  const { workspaceId: _workspaceId, ...view } = record

  return view
}

function toStoredColumns(input: UpdateFormInput): Partial<repository.FormColumns> {
  return {
    ...(input.name === undefined ? {} : { name: input.name }),
    ...(input.description === undefined ? {} : { description: input.description }),
    ...(input.status === undefined ? {} : { status: input.status }),
    ...(input.thankYouMessage === undefined ? {} : { thankYouMessage: input.thankYouMessage }),
    ...(input.createDeal === undefined ? {} : { createDeal: input.createDeal }),
    ...(input.dealStageId === undefined ? {} : { dealStageId: input.dealStageId }),
    ...(input.dealNameTemplate === undefined ? {} : { dealNameTemplate: input.dealNameTemplate }),
  }
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
   * A stage a form's deals may open in: in this workspace, and in the deal
   * pipeline.
   *
   * The wrong-workspace case reads as missing, per `api.md`. The wrong-pipeline
   * case is a request naming a real stage that can never hold a deal, which is a
   * validation error rather than a missing record. Same rule the deals service
   * applies to `stage_id`.
   */
  async function requireDealStage(workspaceId: string, stageId: string): Promise<void> {
    const stage = await pipelineRepository.findStage(dependencies.db, workspaceId, stageId)

    if (stage === undefined) {
      throw AppError.notFound('Pipeline stage not found')
    }

    if (stage.kind !== 'deal') {
      throw AppError.validationFailed('That stage is not part of the deal pipeline', [
        { field: 'deal_stage_id', message: `It belongs to the ${stage.kind} pipeline` },
      ])
    }
  }

  /**
   * @param createsDeal Part of the check, not context: whether a form needs a
   *   company mapping depends on it, so the two are validated together.
   * @throws AppError 422 listing every problem with the field list at once.
   */
  function requireUsableFields(fields: readonly FieldShape[], createsDeal: boolean): void {
    const problems = findFieldProblems(fields, createsDeal)

    if (problems.length > 0) {
      throw AppError.validationFailed('That field list cannot process a submission', problems)
    }
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

    return records.map((record) =>
      toView(
        record,
        fields.filter((field) => field.formId === record.id),
      ),
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

      return toView(form, await repository.listFields(dependencies.db, id))
    },

    async create(actor, input) {
      const workspaceId = requireWorkspaceId(actor)

      requireUsableFields(input.fields, input.createDeal)

      if (input.dealStageId !== null) {
        await requireDealStage(workspaceId, input.dealStageId)
      }

      const id = dependencies.createId('form')

      return dependencies.transaction(async ({ tx, events }) => {
        const created = await repository.insertForm(tx, {
          id,
          workspaceId,
          name: input.name,
          description: input.description,
          status: input.status,
          thankYouMessage: input.thankYouMessage,
          createDeal: input.createDeal,
          dealStageId: input.dealStageId,
          dealNameTemplate: input.dealNameTemplate,
          publicKey: generatePublicKey(),
        })
        const fields = await writeFields(tx, workspaceId, id, input.fields)

        events.emit('record.created', { workspaceId, objectType: 'form', recordId: id })

        return toView(created, fields)
      })
    },

    async update(actor, id, changes) {
      const workspaceId = requireWorkspaceId(actor)
      const existing = await require(workspaceId, id)
      const stored = await repository.listFields(dependencies.db, id)

      // Validated against the state the request would leave behind, not against
      // what it carried. Turning `create_deal` on is what makes a form with no
      // company mapping unusable, and that request names no fields at all.
      requireUsableFields(
        changes.fields ?? stored,
        changes.createDeal ?? existing.createDeal,
      )

      if (typeof changes.dealStageId === 'string' && changes.dealStageId !== existing.dealStageId) {
        await requireDealStage(workspaceId, changes.dealStageId)
      }

      const columns = toStoredColumns(changes)
      const written = changedKeys(existing, columns)

      // A resent field list that matches what is stored is not a write. Rewriting
      // it would move every field id and publish a `record.updated` no consumer
      // can act on, which is the same reason `changedKeys` guards the columns.
      const rewritesFields = changes.fields !== undefined && fieldsDiffer(stored, changes.fields)

      if (written.length === 0 && !rewritesFields) {
        return toView(existing, stored)
      }

      return dependencies.transaction(async ({ tx, events }) => {
        // A changed field list is a change to the form, so it stamps
        // `updated_at` even when no column of the form itself moved.
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

        events.emit('record.updated', {
          workspaceId,
          objectType: 'form',
          recordId: id,
          changedFields: rewritesFields ? [...written, 'fields'] : written,
        })

        return toView(updated, fields)
      })
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

        events.emit('record.deleted', { workspaceId, objectType: 'form', recordId: id })
      })
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
  }
}
