import { z } from 'zod'

import { CONSENT_PURPOSE_STATUSES } from './values.ts'
import type { ConsentPurposeStatus, ConsentStatus } from './values.ts'
import { definedFields, nullableTimestampSchema } from './wire.ts'

/**
 * The effective consent status for a (person, purpose) pair.
 *
 * `inherited: true` means the person has no explicit `person_consents` row for
 * the purpose and the reader is looking at the purpose's `default_status`. In
 * that case `source` and `notedAt` are null. `inherited: false` means the row
 * exists and carries its own `granted | withdrawn`, `source`, and `notedAt`.
 */
export interface PersonConsent {
  /** The purpose's slug — the identity that survives a rename of its label. */
  readonly purposeSlug: string
  readonly purposeLabel: string
  readonly status: ConsentPurposeStatus
  readonly source: string | null
  readonly notedAt: Date | null
  readonly inherited: boolean
}

export const personConsentSchema: z.ZodType<PersonConsent, unknown> = z
  .object({
    purpose_slug: z.string(),
    purpose_label: z.string(),
    status: z.enum(CONSENT_PURPOSE_STATUSES),
    source: z.string().nullable(),
    noted_at: nullableTimestampSchema,
    inherited: z.boolean(),
  })
  .transform(
    (wire): PersonConsent => ({
      purposeSlug: wire.purpose_slug,
      purposeLabel: wire.purpose_label,
      status: wire.status,
      source: wire.source,
      notedAt: wire.noted_at,
      inherited: wire.inherited,
    }),
  )

/**
 * What a manual override writes for one (person, purpose) pair. A `status` of
 * `granted` or `withdrawn` upserts the row (`source: manual`); a `null` status
 * clears the row and falls the pair back to the purpose's default.
 */
export interface PersonConsentInput {
  readonly purposeSlug: string
  readonly status: ConsentStatus | null
}

export function personConsentWriteBody(input: PersonConsentInput): Record<string, unknown> {
  return definedFields({
    purpose_slug: input.purposeSlug,
    status: input.status,
  })
}
