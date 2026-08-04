import type { Context, Hono } from 'hono'
import { z } from 'zod'

import { AppError } from '../../lib/errors.ts'
import {
  PUBLIC_ROUTE_PREFIX,
  pageBody,
  readJsonBody,
  readListParameters,
  requestOrigin,
} from '../../lib/http.ts'
import type { Actor } from '../auth/actor.ts'
import { resolveActorFrom } from '../auth/credentials.ts'
import type { CredentialDependencies } from '../auth/credentials.ts'
import { embedSnippets } from './embed.ts'
import type { FieldDraft } from './fields.ts'
import {
  FORM_FIELD_MAP_TARGETS,
  FORM_FIELD_TYPES,
  FORM_OPTION_VALUE_TYPES,
  FORM_STATUSES,
} from './schema.ts'
import type { FormStatus } from './schema.ts'
import type {
  CreateFormInput,
  FormSubmissionView,
  FormView,
  FormsService,
  UpdateFormInput,
} from './service.ts'

/**
 * Wire shapes for `/v1/forms`. Bodies are strict; an unknown field is a 422, per
 * `api.md`.
 *
 * Fields are nested rather than their own resource, and a write carries the
 * whole list. Field ids therefore never appear in a request: they are assigned
 * on write, and a client that wants to change one field sends the list back with
 * that field changed. That is also exactly what a drag-reorder sends.
 */

const optionBody = z.strictObject({
  key: z.string().min(1),
  value: z.string().min(1),
  value_type: z.enum(FORM_OPTION_VALUE_TYPES).default('string'),
})

const fieldBody = z.strictObject({
  label: z.string().min(1),
  type: z.enum(FORM_FIELD_TYPES),
  required: z.boolean().default(false),
  map_to: z.enum(FORM_FIELD_MAP_TARGETS),
  options: z.array(optionBody).default([]),
  placeholder: z.string().nullable().default(null),
})

const formShape = {
  name: z.string().min(1),
  description: z.string().nullable(),
  status: z.enum(FORM_STATUSES),
  fields: z.array(fieldBody),
  thank_you_message: z.string(),
  create_deal: z.boolean(),
  deal_stage_id: z.string().min(1).nullable(),
  deal_name_template: z.string().nullable(),
}

/**
 * A name and a field list are the whole requirement.
 *
 * A form is created active, because a form nobody can submit to is not a state
 * anybody asks for on purpose; pausing it is one PATCH away. An absent
 * `deal_stage_id` with `create_deal` on means the pipeline's first open stage,
 * resolved at submit time rather than frozen at create time, so a workspace that
 * reorders its board does not leave old forms pointing at a stage it moved.
 */
const createBody = z.strictObject({
  ...formShape,
  description: formShape.description.default(null),
  status: formShape.status.default('active'),
  thank_you_message: formShape.thank_you_message.default('Thanks. We will be in touch.'),
  create_deal: formShape.create_deal.default(false),
  deal_stage_id: formShape.deal_stage_id.default(null),
  deal_name_template: formShape.deal_name_template.default(null),
})

const updateBody = z.strictObject(formShape).partial()

const statusFilter = z.enum(FORM_STATUSES)

export interface FormsRoutesDependencies extends CredentialDependencies {
  readonly service: FormsService
}

function readStatusFilter(context: Context): FormStatus | undefined {
  const raw = context.req.query('status')

  if (raw === undefined) {
    return undefined
  }

  const parsed = statusFilter.safeParse(raw)

  // Silently answering "no forms" would report a typo as an empty workspace.
  if (!parsed.success) {
    throw AppError.validationFailed('That form status does not exist', [
      { field: 'status', message: `Use one of: ${FORM_STATUSES.join(', ')}` },
    ])
  }

  return parsed.data
}

function toFieldDraft(field: z.infer<typeof fieldBody>): FieldDraft {
  return {
    label: field.label,
    type: field.type,
    required: field.required,
    mapTo: field.map_to,
    options: field.options.map((option) => ({
      key: option.key,
      value: option.value,
      valueType: option.value_type,
    })),
    placeholder: field.placeholder,
  }
}

function toCreateInput(body: z.infer<typeof createBody>): CreateFormInput {
  return {
    name: body.name,
    description: body.description,
    status: body.status,
    fields: body.fields.map(toFieldDraft),
    thankYouMessage: body.thank_you_message,
    createDeal: body.create_deal,
    dealStageId: body.deal_stage_id,
    dealNameTemplate: body.deal_name_template,
  }
}

function toUpdateInput(body: z.infer<typeof updateBody>): UpdateFormInput {
  return {
    ...(body.name === undefined ? {} : { name: body.name }),
    ...(body.description === undefined ? {} : { description: body.description }),
    ...(body.status === undefined ? {} : { status: body.status }),
    ...(body.fields === undefined ? {} : { fields: body.fields.map(toFieldDraft) }),
    ...(body.thank_you_message === undefined ? {} : { thankYouMessage: body.thank_you_message }),
    ...(body.create_deal === undefined ? {} : { createDeal: body.create_deal }),
    ...(body.deal_stage_id === undefined ? {} : { dealStageId: body.deal_stage_id }),
    ...(body.deal_name_template === undefined
      ? {}
      : { dealNameTemplate: body.deal_name_template }),
  }
}

export function formResponse(form: FormView): Record<string, unknown> {
  return {
    id: form.id,
    name: form.name,
    description: form.description,
    status: form.status,
    fields: form.fields.map((field) => ({
      id: field.id,
      label: field.label,
      type: field.type,
      required: field.required,
      map_to: field.mapTo,
      options: field.options.map((option) => ({
        key: option.key,
        value: option.value,
        value_type: option.valueType,
      })),
      placeholder: field.placeholder,
      sort_order: field.sortOrder,
    })),
    thank_you_message: form.thankYouMessage,
    create_deal: form.createDeal,
    deal_stage_id: form.dealStageId,
    deal_name_template: form.dealNameTemplate,
    public_key: form.publicKey,
    created_at: form.createdAt.toISOString(),
    updated_at: form.updatedAt.toISOString(),
  }
}

export function formSubmissionResponse(submission: FormSubmissionView): Record<string, unknown> {
  return {
    id: submission.id,
    form_id: submission.formId,
    submitted_at: submission.submittedAt.toISOString(),
    answers: submission.answers,
    person_id: submission.personId,
    company_id: submission.companyId,
    position_id: submission.positionId,
    deal_id: submission.dealId,
    created_at: submission.createdAt.toISOString(),
  }
}

/** The absolute URL of a form's hosted embed page, on the origin this request arrived at. */
export function embedUrlFor(context: Context, publicKey: string): string {
  return `${requestOrigin(context)}${PUBLIC_ROUTE_PREFIX}/forms/${publicKey}/embed`
}

export function mountFormsRoutes(router: Hono, dependencies: FormsRoutesDependencies): void {
  const requireActor = (context: Context): Promise<Actor> => resolveActorFrom(dependencies, context)

  router.get('/forms', async (context) => {
    const page = await dependencies.service.list(
      await requireActor(context),
      { term: context.req.query('q'), status: readStatusFilter(context) },
      readListParameters(context),
    )

    return context.json(pageBody(page, formResponse))
  })

  router.post('/forms', async (context) => {
    const body = await readJsonBody(context, createBody)
    const form = await dependencies.service.create(await requireActor(context), toCreateInput(body))

    return context.json(formResponse(form), 201)
  })

  router.get('/forms/:id', async (context) => {
    const form = await dependencies.service.get(await requireActor(context), context.req.param('id'))

    return context.json(formResponse(form))
  })

  router.patch('/forms/:id', async (context) => {
    const body = await readJsonBody(context, updateBody)
    const form = await dependencies.service.update(
      await requireActor(context),
      context.req.param('id'),
      toUpdateInput(body),
    )

    return context.json(formResponse(form))
  })

  router.delete('/forms/:id', async (context) => {
    await dependencies.service.remove(await requireActor(context), context.req.param('id'))

    return context.body(null, 204)
  })

  router.get('/forms/:id/submissions', async (context) => {
    const page = await dependencies.service.listSubmissions(
      await requireActor(context),
      context.req.param('id'),
      readListParameters(context),
    )

    return context.json(pageBody(page, formSubmissionResponse))
  })

  /**
   * What to paste into a website.
   *
   * Its own endpoint rather than a field on the form, so the form's shape is the
   * same on a list and on a read. The snippets are derived from the request's
   * origin and the form's `public_key`, neither of which is stored.
   */
  router.get('/forms/:id/embed', async (context) => {
    const form = await dependencies.service.get(await requireActor(context), context.req.param('id'))
    const snippets = embedSnippets(embedUrlFor(context, form.publicKey), form.id)

    return context.json({
      url: snippets.url,
      iframe_snippet: snippets.iframe,
      script_snippet: snippets.script,
    })
  })
}
