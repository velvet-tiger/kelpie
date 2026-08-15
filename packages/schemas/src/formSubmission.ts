import { z } from 'zod'

import { idSchema, timestampSchema } from './wire.ts'

/**
 * Wire shape for `/v1/forms/:id/submissions`, and for what the public submit
 * endpoint answers with.
 *
 * Read-only over the API: a submission is evidence of what arrived, so there is
 * no create body here (the public endpoint takes an answer map, not a
 * submission) and no update at all.
 */

export interface FormSubmission {
  readonly id: string
  readonly formId: string
  readonly submittedAt: Date
  /** Field id to the answer given: a select option's `key`, or free text. */
  readonly answers: Readonly<Record<string, string>>
  /**
   * What the submit created or matched. Each is null when the rule did not
   * apply, and each becomes null again if that record is later deleted: the
   * submission outlives what it produced.
   */
  readonly personId: string | null
  readonly companyId: string | null
  readonly positionId: string | null
  readonly dealId: string | null
  readonly createdAt: Date
}

export const formSubmissionSchema: z.ZodType<FormSubmission, unknown> = z
  .object({
    id: idSchema,
    form_id: idSchema,
    submitted_at: timestampSchema,
    answers: z.record(z.string(), z.string()),
    person_id: idSchema.nullable(),
    company_id: idSchema.nullable(),
    position_id: idSchema.nullable(),
    deal_id: idSchema.nullable(),
    created_at: timestampSchema,
  })
  .transform(
    (wire): FormSubmission => ({
      id: wire.id,
      formId: wire.form_id,
      submittedAt: wire.submitted_at,
      answers: wire.answers,
      personId: wire.person_id,
      companyId: wire.company_id,
      positionId: wire.position_id,
      dealId: wire.deal_id,
      createdAt: wire.created_at,
    }),
  )

/**
 * What the public submit endpoint answers with.
 *
 * It carries no upserted record ids. The caller is an unauthenticated website,
 * and a Kelpie id is a ULID whose timestamp would tell that caller whether the
 * person or company it named was already in the CRM. The stored submission
 * (`formSubmissionSchema`), read over the authenticated API, still holds them.
 */
export interface FormSubmitResult {
  readonly id: string
  readonly formId: string
  readonly submittedAt: Date
  /** The form's configured confirmation, so an embed can render it without a second request. */
  readonly thankYouMessage: string
}

export const formSubmitResultSchema: z.ZodType<FormSubmitResult, unknown> = z
  .object({
    id: idSchema,
    form_id: idSchema,
    submitted_at: timestampSchema,
    thank_you_message: z.string(),
  })
  .transform(
    (wire): FormSubmitResult => ({
      id: wire.id,
      formId: wire.form_id,
      submittedAt: wire.submitted_at,
      thankYouMessage: wire.thank_you_message,
    }),
  )
