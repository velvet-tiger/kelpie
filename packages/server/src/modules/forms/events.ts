import { z } from 'zod'

import type { ModuleEventCatalog } from '../../runtime/module.ts'

/**
 * Domain events published by the forms module.
 *
 * `forms.form.*` cover the form definition CRUD. `forms.submission.submitted`
 * fires once per submission; the webhooks bridge translates it to the wire
 * `form.submitted` event (the ids live in `data`).
 */

export const formsEvents = {
  'forms.form.created': z.object({}).strict(),
  'forms.form.updated': z.object({ changed: z.array(z.string()).readonly() }),
  'forms.form.deleted': z.object({}).strict(),
  'forms.submission.submitted': z.object({ formId: z.string(), submissionId: z.string() }),
} satisfies ModuleEventCatalog

export type FormCreatedData = Record<string, never>
export interface FormUpdatedData {
  readonly changed: readonly string[]
}
export type FormDeletedData = Record<string, never>
export interface FormSubmissionData {
  readonly formId: string
  readonly submissionId: string
}

declare module '../../runtime/events.ts' {
  interface KelpieEventMap {
    'forms.form.created': FormCreatedData
    'forms.form.updated': FormUpdatedData
    'forms.form.deleted': FormDeletedData
    'forms.submission.submitted': FormSubmissionData
  }
}
