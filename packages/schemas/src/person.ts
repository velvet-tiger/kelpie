import { z } from 'zod'

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
  readonly name: string
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
}

const socialProfileSchema = z.object({
  network: z.enum(SOCIAL_NETWORK_IDS),
  url: z.string(),
})

export const personSchema: z.ZodType<Person, unknown> = z
  .object({
    id: idSchema,
    name: z.string(),
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
    ...recordTimestamps,
  })
  .transform(
    (wire): Person => ({
      id: wire.id,
      name: wire.name,
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
      createdAt: wire.created_at,
      updatedAt: wire.updated_at,
    }),
  )

/**
 * A create or update body. Every field is optional because `POST` defaults all
 * but `name` server-side and `PATCH` sends only what changed; `name` is required
 * on create by the route, not by this type.
 */
export interface PersonInput {
  readonly name?: string
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
}

export function personBody(input: PersonInput): Record<string, unknown> {
  return definedFields({
    name: input.name,
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
  })
}
