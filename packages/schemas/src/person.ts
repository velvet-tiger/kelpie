import { z } from 'zod'

import {
  customFieldValuesBody,
  customFieldValuesSchema,
} from './customField.ts'
import type { CustomFieldValue, CustomFieldValues } from './customField.ts'
import { personConsentSchema, personConsentWriteBody } from './personConsent.ts'
import type { PersonConsent, PersonConsentInput } from './personConsent.ts'
import {
  INFLUENCE_LEVELS,
  PREFERRED_CHANNELS,
  RELATIONSHIP_LEVELS,
  SOCIAL_NETWORK_IDS,
} from './values.ts'
import type { Influence, PreferredChannel, Relationship, SocialNetworkId } from './values.ts'
import { definedFields, idSchema, nullableTimestampSchema, recordTimestamps } from './wire.ts'
import type { RecordTimestamps } from './wire.ts'

/** Wire and write shapes for `/v1/people`. Job title is not here: it lives on Position. */

export interface SocialProfile {
  readonly network: SocialNetworkId
  readonly url: string
}

export interface Person extends RecordTimestamps {
  readonly id: string
  /**
   * What to call this person: the canonical display string, and the only name
   * field every consumer reads. The parts below are optional detail beside it,
   * never a replacement for it, so a mononym and a four-part name are both just
   * a `name`.
   */
  readonly name: string
  /** A form of address — "Dr", "Ms". Not a job title: that is on Position. */
  readonly salutation: string | null
  readonly firstName: string | null
  readonly lastName: string | null
  /** A generational or post-nominal suffix — "Jr", "III", "PhD". */
  readonly suffix: string | null
  readonly email: string | null
  readonly phones: readonly string[]
  readonly socialProfiles: readonly SocialProfile[]
  readonly timezone: string | null
  readonly location: string | null
  readonly preferredChannel: PreferredChannel
  readonly influence: Influence
  readonly relationship: Relationship
  readonly summary: string
  readonly tags: readonly string[]
  readonly lastContactedAt: Date | null
  /** The Article 21 objection. Global, independent of consent purposes. */
  readonly doNotContact: boolean
  /**
   * One entry per workspace consent purpose, with the effective status
   * (an explicit `person_consents` row if one exists, else the purpose's
   * `default_status`). Ordered by the purpose's `sort_order`.
   */
  readonly consents: readonly PersonConsent[]
  /** Workspace-defined fields, keyed by definition key. Always present (default `{}`). */
  readonly customFields: CustomFieldValues
}

const socialProfileSchema = z.object({
  network: z.enum(SOCIAL_NETWORK_IDS),
  url: z.string(),
})

export const personSchema: z.ZodType<Person, unknown> = z
  .object({
    id: idSchema,
    name: z.string(),
    salutation: z.string().nullable(),
    first_name: z.string().nullable(),
    last_name: z.string().nullable(),
    suffix: z.string().nullable(),
    email: z.string().nullable(),
    phones: z.array(z.string()),
    social_profiles: z.array(socialProfileSchema),
    timezone: z.string().nullable(),
    location: z.string().nullable(),
    preferred_channel: z.enum(PREFERRED_CHANNELS),
    influence: z.enum(INFLUENCE_LEVELS),
    relationship: z.enum(RELATIONSHIP_LEVELS),
    summary: z.string(),
    tags: z.array(z.string()),
    last_contacted_at: nullableTimestampSchema,
    do_not_contact: z.boolean(),
    consents: z.array(personConsentSchema),
    custom_fields: customFieldValuesSchema,
    ...recordTimestamps,
  })
  .transform(
    (wire): Person => ({
      id: wire.id,
      name: wire.name,
      salutation: wire.salutation,
      firstName: wire.first_name,
      lastName: wire.last_name,
      suffix: wire.suffix,
      email: wire.email,
      phones: wire.phones,
      socialProfiles: wire.social_profiles,
      timezone: wire.timezone,
      location: wire.location,
      preferredChannel: wire.preferred_channel,
      influence: wire.influence,
      relationship: wire.relationship,
      summary: wire.summary,
      tags: wire.tags,
      lastContactedAt: wire.last_contacted_at,
      doNotContact: wire.do_not_contact,
      consents: wire.consents,
      customFields: wire.custom_fields,
      createdAt: wire.created_at,
      updatedAt: wire.updated_at,
    }),
  )

/**
 * A create or update body. Every field is optional because `POST` defaults all
 * but `name` server-side and `PATCH` sends only what changed; `name` is required
 * on create by the route, not by this type — and a create may send `first_name`
 * and `last_name` instead, which the route composes a `name` from.
 */
export interface PersonInput {
  readonly name?: string
  readonly salutation?: string | null
  readonly firstName?: string | null
  readonly lastName?: string | null
  readonly suffix?: string | null
  readonly email?: string | null
  readonly phones?: readonly string[]
  readonly socialProfiles?: readonly SocialProfile[]
  readonly timezone?: string | null
  readonly location?: string | null
  readonly preferredChannel?: PreferredChannel
  readonly influence?: Influence
  readonly relationship?: Relationship
  readonly summary?: string
  readonly tags?: readonly string[]
  readonly lastContactedAt?: Date | null
  readonly doNotContact?: boolean
  /**
   * Manual override of one or more consent purposes. Each entry upserts a
   * `person_consents` row (`source: manual`); `status: null` clears the row
   * and inherits the purpose's default. Absent purposes are left alone.
   */
  readonly consents?: readonly PersonConsentInput[]
  /**
   * Partial merge patch: sent keys change, `null` clears a key, absent keys are
   * left alone. Unknown keys are rejected at `422`.
   */
  readonly customFields?: Readonly<Record<string, CustomFieldValue | null>>
}

export function personBody(input: PersonInput): Record<string, unknown> {
  return definedFields({
    name: input.name,
    salutation: input.salutation,
    first_name: input.firstName,
    last_name: input.lastName,
    suffix: input.suffix,
    email: input.email,
    phones: input.phones,
    social_profiles: input.socialProfiles,
    timezone: input.timezone,
    location: input.location,
    preferred_channel: input.preferredChannel,
    influence: input.influence,
    relationship: input.relationship,
    summary: input.summary,
    tags: input.tags,
    last_contacted_at:
      input.lastContactedAt === undefined || input.lastContactedAt === null
        ? input.lastContactedAt
        : input.lastContactedAt.toISOString(),
    do_not_contact: input.doNotContact,
    consents: input.consents?.map(personConsentWriteBody),
    custom_fields:
      input.customFields === undefined ? undefined : customFieldValuesBody(input.customFields),
  })
}
