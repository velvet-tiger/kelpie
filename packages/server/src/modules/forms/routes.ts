import type { Context, Hono } from 'hono'
import { z } from 'zod'
import {
  FORM_ATTACH_TARGET_TYPES,
  FORM_SLUG_PATTERN,
  FORM_SUBMISSION_LINK_TARGETS,
} from '@kelpie/schemas'
import type { FormAttachTarget, FormSubmissionLinkTarget } from '@kelpie/schemas'

import { AppError } from '../../lib/errors.ts'
import {
  PUBLIC_ROUTE_PREFIX,
  pageBody,
  readJsonBody,
  readListParameters,
  requestOrigin,
} from '../../lib/http.ts'
import type { Actor } from '../auth/actor.ts'
import { requireWorkspaceId } from '../auth/actor.ts'
import { resolveActorFrom } from '../auth/credentials.ts'
import type { CredentialDependencies } from '../auth/credentials.ts'
import { embedSnippets } from './embed.ts'
import type { FieldDraft } from './fields.ts'
import {
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
 * Wire shapes for `/v1/forms`. Bodies are strict; an unknown field is a 422.
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
  // May be empty: a field needs no visible heading, such as one checkbox whose
  // own text says everything.
  label: z.string(),
  type: z.enum(FORM_FIELD_TYPES),
  required: z.boolean().default(false),
  map_to: z.string().min(1),
  options: z.array(optionBody).default([]),
  placeholder: z.string().nullable().default(null),
  statement: z.string().nullable().default(null),
  consent_purpose_ids: z.array(z.string().min(1)).default([]),
  consent_purpose_labels: z.record(z.string().min(1), z.string()).default({}),
  list_ids: z.array(z.string().min(1)).default([]),
  list_labels: z.record(z.string().min(1), z.string()).default({}),
})

const attachTargetBody = z.strictObject({
  target_type: z.enum(FORM_ATTACH_TARGET_TYPES),
  target_id: z.string().min(1),
})

const formShape = {
  name: z.string().min(1),
  title: z.string().min(1),
  slug: z
    .string()
    .regex(FORM_SLUG_PATTERN, 'Use 3 to 64 letters, digits, hyphens or underscores'),
  description: z.string().nullable(),
  status: z.enum(FORM_STATUSES),
  fields: z.array(fieldBody),
  thank_you_message: z.string(),
  create_deal: z.boolean(),
  deal_stage_id: z.string().min(1).nullable(),
  deal_name_template: z.string().nullable(),
  create_opportunity: z.boolean(),
  opportunity_kind: z.string().nullable(),
  opportunity_stage_id: z.string().min(1).nullable(),
  opportunity_name_template: z.string().nullable(),
  opportunity_owner_id: z.string().min(1).nullable(),
  create_partnership: z.boolean(),
  partnership_kind: z.string().nullable(),
  partnership_stage_id: z.string().min(1).nullable(),
  partnership_name_template: z.string().nullable(),
  partnership_owner_id: z.string().min(1).nullable(),
  create_enquiry: z.boolean(),
  enquiry_source: z.string().nullable(),
  enquiry_stage_id: z.string().min(1).nullable(),
  enquiry_name_template: z.string().nullable(),
  enquiry_owner_id: z.string().min(1).nullable(),
  person_tags: z.array(z.string().min(1)),
  company_tags: z.array(z.string().min(1)),
  list_ids: z.array(z.string().min(1)),
  attach_targets: z.array(attachTargetBody),
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
export const createBody = z.strictObject({
  ...formShape,
  // Absent → copy of `name` in `toCreateInput`, so a create that only names the
  // form still gets a public heading without a second field on every caller.
  title: formShape.title.optional(),
  // Absent → a random slug in the service. A caller that wants a readable URL names one.
  slug: formShape.slug.optional(),
  description: formShape.description.default(null),
  status: formShape.status.default('active'),
  thank_you_message: formShape.thank_you_message.default('Thanks. We will be in touch.'),
  create_deal: formShape.create_deal.default(false),
  deal_stage_id: formShape.deal_stage_id.default(null),
  deal_name_template: formShape.deal_name_template.default(null),
  create_opportunity: formShape.create_opportunity.default(false),
  opportunity_kind: formShape.opportunity_kind.default(null),
  opportunity_stage_id: formShape.opportunity_stage_id.default(null),
  opportunity_name_template: formShape.opportunity_name_template.default(null),
  opportunity_owner_id: formShape.opportunity_owner_id.default(null),
  create_partnership: formShape.create_partnership.default(false),
  partnership_kind: formShape.partnership_kind.default(null),
  partnership_stage_id: formShape.partnership_stage_id.default(null),
  partnership_name_template: formShape.partnership_name_template.default(null),
  partnership_owner_id: formShape.partnership_owner_id.default(null),
  create_enquiry: formShape.create_enquiry.default(false),
  enquiry_source: formShape.enquiry_source.default(null),
  enquiry_stage_id: formShape.enquiry_stage_id.default(null),
  enquiry_name_template: formShape.enquiry_name_template.default(null),
  enquiry_owner_id: formShape.enquiry_owner_id.default(null),
  person_tags: formShape.person_tags.default([]),
  company_tags: formShape.company_tags.default([]),
  list_ids: formShape.list_ids.default([]),
  attach_targets: formShape.attach_targets.default([]),
})

export const updateBody = z.strictObject(formShape).partial()

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
    statement: field.statement,
    consentPurposeIds: field.consent_purpose_ids,
    consentPurposeLabels: field.consent_purpose_labels,
    listIds: field.list_ids,
    listLabels: field.list_labels,
  }
}

function toAttachTarget(body: z.infer<typeof attachTargetBody>): FormAttachTarget {
  return { targetType: body.target_type, targetId: body.target_id }
}

export function toCreateInput(body: z.infer<typeof createBody>): CreateFormInput {
  return {
    name: body.name,
    title: body.title ?? body.name,
    slug: body.slug ?? null,
    description: body.description,
    status: body.status,
    fields: body.fields.map(toFieldDraft),
    thankYouMessage: body.thank_you_message,
    createDeal: body.create_deal,
    dealStageId: body.deal_stage_id,
    dealNameTemplate: body.deal_name_template,
    createOpportunity: body.create_opportunity,
    opportunityKind: body.opportunity_kind,
    opportunityStageId: body.opportunity_stage_id,
    opportunityNameTemplate: body.opportunity_name_template,
    opportunityOwnerId: body.opportunity_owner_id,
    createPartnership: body.create_partnership,
    partnershipKind: body.partnership_kind,
    partnershipStageId: body.partnership_stage_id,
    partnershipNameTemplate: body.partnership_name_template,
    partnershipOwnerId: body.partnership_owner_id,
    createEnquiry: body.create_enquiry,
    enquirySource: body.enquiry_source,
    enquiryStageId: body.enquiry_stage_id,
    enquiryNameTemplate: body.enquiry_name_template,
    enquiryOwnerId: body.enquiry_owner_id,
    personTags: body.person_tags,
    companyTags: body.company_tags,
    listIds: body.list_ids,
    attachTargets: body.attach_targets.map(toAttachTarget),
  }
}

export function toUpdateInput(body: z.infer<typeof updateBody>): UpdateFormInput {
  return {
    ...(body.name === undefined ? {} : { name: body.name }),
    ...(body.title === undefined ? {} : { title: body.title }),
    ...(body.slug === undefined ? {} : { slug: body.slug }),
    ...(body.description === undefined ? {} : { description: body.description }),
    ...(body.status === undefined ? {} : { status: body.status }),
    ...(body.fields === undefined ? {} : { fields: body.fields.map(toFieldDraft) }),
    ...(body.thank_you_message === undefined ? {} : { thankYouMessage: body.thank_you_message }),
    ...(body.create_deal === undefined ? {} : { createDeal: body.create_deal }),
    ...(body.deal_stage_id === undefined ? {} : { dealStageId: body.deal_stage_id }),
    ...(body.deal_name_template === undefined
      ? {}
      : { dealNameTemplate: body.deal_name_template }),
    ...(body.create_opportunity === undefined
      ? {}
      : { createOpportunity: body.create_opportunity }),
    ...(body.opportunity_kind === undefined ? {} : { opportunityKind: body.opportunity_kind }),
    ...(body.opportunity_stage_id === undefined
      ? {}
      : { opportunityStageId: body.opportunity_stage_id }),
    ...(body.opportunity_name_template === undefined
      ? {}
      : { opportunityNameTemplate: body.opportunity_name_template }),
    ...(body.opportunity_owner_id === undefined
      ? {}
      : { opportunityOwnerId: body.opportunity_owner_id }),
    ...(body.create_partnership === undefined
      ? {}
      : { createPartnership: body.create_partnership }),
    ...(body.partnership_kind === undefined ? {} : { partnershipKind: body.partnership_kind }),
    ...(body.partnership_stage_id === undefined
      ? {}
      : { partnershipStageId: body.partnership_stage_id }),
    ...(body.partnership_name_template === undefined
      ? {}
      : { partnershipNameTemplate: body.partnership_name_template }),
    ...(body.partnership_owner_id === undefined
      ? {}
      : { partnershipOwnerId: body.partnership_owner_id }),
    ...(body.create_enquiry === undefined ? {} : { createEnquiry: body.create_enquiry }),
    ...(body.enquiry_source === undefined ? {} : { enquirySource: body.enquiry_source }),
    ...(body.enquiry_stage_id === undefined ? {} : { enquiryStageId: body.enquiry_stage_id }),
    ...(body.enquiry_name_template === undefined
      ? {}
      : { enquiryNameTemplate: body.enquiry_name_template }),
    ...(body.enquiry_owner_id === undefined ? {} : { enquiryOwnerId: body.enquiry_owner_id }),
    ...(body.person_tags === undefined ? {} : { personTags: body.person_tags }),
    ...(body.company_tags === undefined ? {} : { companyTags: body.company_tags }),
    ...(body.list_ids === undefined ? {} : { listIds: body.list_ids }),
    ...(body.attach_targets === undefined
      ? {}
      : { attachTargets: body.attach_targets.map(toAttachTarget) }),
  }
}

export function formResponse(form: FormView): Record<string, unknown> {
  return {
    id: form.id,
    name: form.name,
    title: form.title,
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
      statement: field.statement,
      consent_purpose_ids: field.consentPurposeIds,
      consent_purpose_labels: field.consentPurposeLabels,
      list_ids: field.listIds,
      list_labels: field.listLabels,
      sort_order: field.sortOrder,
    })),
    thank_you_message: form.thankYouMessage,
    create_deal: form.createDeal,
    deal_stage_id: form.dealStageId,
    deal_name_template: form.dealNameTemplate,
    create_opportunity: form.createOpportunity,
    opportunity_kind: form.opportunityKind,
    opportunity_stage_id: form.opportunityStageId,
    opportunity_name_template: form.opportunityNameTemplate,
    opportunity_owner_id: form.opportunityOwnerId,
    create_partnership: form.createPartnership,
    partnership_kind: form.partnershipKind,
    partnership_stage_id: form.partnershipStageId,
    partnership_name_template: form.partnershipNameTemplate,
    partnership_owner_id: form.partnershipOwnerId,
    create_enquiry: form.createEnquiry,
    enquiry_source: form.enquirySource,
    enquiry_stage_id: form.enquiryStageId,
    enquiry_name_template: form.enquiryNameTemplate,
    enquiry_owner_id: form.enquiryOwnerId,
    person_tags: form.personTags,
    company_tags: form.companyTags,
    list_ids: form.listIds,
    attach_targets: form.attachTargets.map((target) => ({
      target_type: target.targetType,
      target_id: target.targetId,
    })),
    slug: form.slug,
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
    opportunity_id: submission.opportunityId,
    partnership_id: submission.partnershipId,
    enquiry_id: submission.enquiryId,
    action_log: submission.actionLog.map((entry) => ({
      action: entry.action,
      status: entry.status,
      detail: entry.detail,
    })),
    created_at: submission.createdAt.toISOString(),
  }
}

function publicFormsBase(context: Context, workspaceId: string): string {
  return `${requestOrigin(context)}${PUBLIC_ROUTE_PREFIX}/workspaces/${workspaceId}/forms`
}

/**
 * The absolute URL a form submits to, `…/forms/:slug/submit`.
 *
 * The one public URL built from the slug, so regenerating the slug moves only
 * this. The embed page is rendered per request and carries the current value,
 * so every embed follows within its cache window, and a caller that saved the
 * old URL gets a 404. The slug is URL-safe (`FORM_SLUG_PATTERN`) and needs no
 * escaping.
 */
export function submitUrlFor(context: Context, workspaceId: string, slug: string): string {
  return `${publicFormsBase(context, workspaceId)}/${slug}/submit`
}

/**
 * The absolute URL of a form's bare iframe document (fields only).
 *
 * Built from the form id, not the slug. This is the URL a customer pastes into
 * their site, and Kelpie cannot edit that site, so it must never change.
 */
export function embedUrlFor(context: Context, workspaceId: string, formId: string): string {
  return `${publicFormsBase(context, workspaceId)}/${formId}/embed`
}

/** The absolute URL of a form's standalone hosted page (brand chrome). Stable, like the embed. */
export function hostedUrlFor(context: Context, workspaceId: string, formId: string): string {
  return `${embedUrlFor(context, workspaceId, formId)}?view=page`
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

  /**
   * Replaces the slug with a new random one, which moves the form's public URLs.
   * An action rather than a PATCH, so the server makes the random value.
   */
  router.post('/forms/:id/regenerate-slug', async (context) => {
    const form = await dependencies.service.regenerateSlug(
      await requireActor(context),
      context.req.param('id'),
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
   * Submissions filtered by the record they touched.
   *
   * `target_type` names one of the seven FK columns a submission carries
   * (person, company, position, deal, opportunity, partnership, enquiry) and
   * `target_id` is the record's id. Both are required — an unfiltered global
   * list of submissions is deliberately not a route here, since a workspace's
   * submissions live under their form, not as a top-level browse.
   */
  router.get('/form-submissions', async (context) => {
    const rawTargetType = context.req.query('target_type')
    const targetId = context.req.query('target_id')

    if (rawTargetType === undefined || targetId === undefined) {
      throw AppError.validationFailed('target_type and target_id are required', [
        { field: 'target_type', message: 'Missing filter' },
        { field: 'target_id', message: 'Missing filter' },
      ])
    }

    if (!(FORM_SUBMISSION_LINK_TARGETS as readonly string[]).includes(rawTargetType)) {
      throw AppError.validationFailed(
        `target_type must be one of ${FORM_SUBMISSION_LINK_TARGETS.join(', ')}`,
        [{ field: 'target_type', message: `Got ${rawTargetType}` }],
      )
    }

    const page = await dependencies.service.listSubmissionsLinkedTo(
      await requireActor(context),
      rawTargetType as FormSubmissionLinkTarget,
      targetId,
      readListParameters(context),
    )

    return context.json(pageBody(page, formSubmissionResponse))
  })

  router.get('/forms/:id/submissions/:submissionId', async (context) => {
    const submission = await dependencies.service.getSubmission(
      await requireActor(context),
      context.req.param('id'),
      context.req.param('submissionId'),
    )

    return context.json(formSubmissionResponse(submission))
  })

  /**
   * What to paste into a website.
   *
   * Its own endpoint rather than a field on the form, so the form's shape is the
   * same on a list and on a read. The snippets are derived from the request's
   * origin, the workspace id and the form id; the origin is not stored. None of
   * them change when the slug does, so a pasted snippet keeps working.
   *
   * `submit_url` is the exception: it is built from the slug, for a site that
   * posts JSON to the form from its own markup, and it moves when the slug does.
   */
  router.get('/forms/:id/embed', async (context) => {
    const actor = await requireActor(context)
    const form = await dependencies.service.get(actor, context.req.param('id'))
    const workspaceId = requireWorkspaceId(actor)
    const snippets = embedSnippets(
      hostedUrlFor(context, workspaceId, form.id),
      embedUrlFor(context, workspaceId, form.id),
      form.id,
    )

    return context.json({
      url: snippets.url,
      embed_url: snippets.embedUrl,
      iframe_snippet: snippets.iframe,
      script_snippet: snippets.script,
      submit_url: submitUrlFor(context, workspaceId, form.slug),
    })
  })
}
