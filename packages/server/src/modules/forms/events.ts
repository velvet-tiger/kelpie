import { FORM_ACTION_STATUSES } from '@kelpie/schemas'
import type { FormActionStatus } from '@kelpie/schemas'
import { z } from 'zod'

import type { ModuleEventCatalog } from '../../runtime/module.ts'

/**
 * Domain events published by the forms module.
 *
 * `forms.form.*` cover the form definition CRUD. `forms.submission.submitted`
 * fires once per submission; the webhooks bridge translates it to the wire
 * `form.submitted` event (the ids and per-action statuses live in `data`).
 *
 * The action summary carries statuses only, no detail strings: the webhook
 * receiver learns whether each action ran; the authenticated Submissions
 * reader gets the full detail from `action_log` on the row.
 */

const actionSummarySchema = z
  .object({
    action: z.string(),
    status: z.enum(FORM_ACTION_STATUSES),
  })
  .readonly()

export const formsEvents = {
  'forms.form.created': z.object({}).strict(),
  'forms.form.updated': z.object({ changed: z.array(z.string()).readonly() }),
  'forms.form.deleted': z.object({}).strict(),
  'forms.submission.submitted': z.object({
    formId: z.string(),
    submissionId: z.string(),
    opportunityId: z.string().nullable(),
    partnershipId: z.string().nullable(),
    enquiryId: z.string().nullable(),
    actions: z.array(actionSummarySchema).readonly(),
  }),
} satisfies ModuleEventCatalog

export type FormCreatedData = Record<string, never>
export interface FormUpdatedData {
  readonly changed: readonly string[]
}
export type FormDeletedData = Record<string, never>
export interface FormSubmissionActionSummary {
  readonly action: string
  readonly status: FormActionStatus
}
export interface FormSubmissionData {
  readonly formId: string
  readonly submissionId: string
  readonly opportunityId: string | null
  readonly partnershipId: string | null
  readonly enquiryId: string | null
  readonly actions: readonly FormSubmissionActionSummary[]
}

declare module '../../runtime/events.ts' {
  interface KelpieEventMap {
    'forms.form.created': FormCreatedData
    'forms.form.updated': FormUpdatedData
    'forms.form.deleted': FormDeletedData
    'forms.submission.submitted': FormSubmissionData
  }
}
