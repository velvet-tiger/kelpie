import { FORM_SUBMISSION_STATUSES } from '@kelpie/schemas'
import { z } from 'zod'

import type { McpToolRegistry } from '../../runtime/module.ts'
import { idArg, listWindowShape, pageResult, registerCrudTools, termArg, toListQuery } from '../crudTools.ts'
import {
  createBody,
  formResponse,
  formSubmissionResponse,
  toCreateInput,
  toUpdateInput,
  updateBody,
} from './routes.ts'
import { FORM_STATUSES } from './schema.ts'
import type { FormsService } from './service.ts'
import type { FormSubmitService } from './submission.ts'

/**
 * `forms_*` and `form_submissions_*`, mirroring form management.
 *
 * No submit tool and no embed tool. Public submit is HTTP-only for browser
 * embeds, and an agent that wants to record an inbound contact creates the Person
 * with the ordinary CRM tools. The embed snippet is built from the origin the
 * request arrived on, which a tool call does not have.
 */

const listArgs = z.strictObject({
  ...listWindowShape,
  q: termArg,
  status: z.enum(FORM_STATUSES).optional().describe('active or paused.'),
})

const submissionListArgs = z.strictObject({
  ...listWindowShape,
  form_id: idArg.describe('The form whose submissions to read.'),
  status: z
    .enum(FORM_SUBMISSION_STATUSES)
    .default('accepted')
    .describe('accepted: what arrived. spam: what the spam check held. Default accepted.'),
})

export function registerFormsTools(
  mcp: McpToolRegistry,
  service: FormsService,
  submissions: FormSubmitService,
): void {
  registerCrudTools(mcp, {
    resource: 'forms',
    subject: 'form',
    about:
      'An embeddable inbound form. A submission upserts a person, a company and a ' +
      'position, and optionally opens a deal.',
    service,
    render: formResponse,
    listArgs,
    toFilters: (args) => ({ term: args.q, status: args.status }),
    createArgs: createBody,
    toCreateInput,
    updateArgs: updateBody.extend({ id: idArg }),
    toUpdateInput,
  })

  mcp.tool({
    name: 'forms_regenerate_slug',
    description:
      "Replace a form's slug with a new random one. This changes the form's public " +
      'URLs, so every website that embeds the form stops working until it gets the ' +
      'new snippet. Mirrors POST /v1/forms/{id}/regenerate-slug.',
    inputSchema: z.strictObject({ id: idArg.describe('The form whose slug to replace.') }),
    invoke: async (args, actor) => formResponse(await service.regenerateSlug(actor, args.id)),
  })

  mcp.tool({
    name: 'form_submissions_list',
    description:
      'List what people submitted through one form, newest first. Cursor paged. ' +
      'Submissions the spam check held are a separate list: pass status "spam". ' +
      'Mirrors GET /v1/forms/{id}/submissions.',
    inputSchema: submissionListArgs,
    invoke: async (args, actor) =>
      pageResult(
        await service.listSubmissions(actor, args.form_id, args.status, toListQuery(args)),
        formSubmissionResponse,
      ),
  })

  mcp.tool({
    name: 'form_submissions_release',
    description:
      'Release a submission the spam check held. The submit rules run on its stored ' +
      'answers: it upserts the person, the company and the position, runs the form\'s ' +
      'actions and sends its emails, as if the submission had just arrived. ' +
      'Mirrors POST /v1/forms/{id}/submissions/{submission_id}/release.',
    inputSchema: z.strictObject({
      form_id: idArg.describe('The form the submission belongs to.'),
      submission_id: idArg.describe('The held submission to release.'),
    }),
    invoke: async (args, actor) =>
      formSubmissionResponse(await submissions.release(actor, args.form_id, args.submission_id)),
  })
}
