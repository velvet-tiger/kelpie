import { z } from 'zod'

import {
  ACCOUNT_TYPES,
  COMPANY_STAGES,
  ICP_FITS,
  INFLUENCE_LEVELS,
  PREFERRED_CHANNELS,
  RELATIONSHIP_LEVELS,
  SIZE_BANDS,
  SOCIAL_NETWORK_IDS,
} from './values.ts'
import type {
  AccountType,
  CompanyStage,
  IcpFit,
  Influence,
  PreferredChannel,
  Relationship,
  SizeBand,
  SocialNetworkId,
} from './values.ts'
import { definedFields } from './wire.ts'

/**
 * Person intake, from the optional `ai` module: paste notes about someone, and
 * Kelpie AI identifies them, researches them, and proposes the records to
 * create. Three calls: `identify`, `research`, `apply`.
 *
 * The snake_case shapes below are the wire contract. The server validates the
 * model's reply and the `apply` body against them, and the UI decodes them to
 * the camelCase types. Every field set is a subset of the matching create body
 * on the CRUD endpoint, so `apply` can hand it straight to that endpoint's tool.
 */

export const PERSON_INTAKE_CONFIDENCES = ['high', 'medium', 'low'] as const

export type PersonIntakeConfidence = (typeof PERSON_INTAKE_CONFIDENCES)[number]

export const PERSON_INTAKE_KINDS = [
  'person',
  'company',
  'position',
  'note',
  'partnership',
  'deal',
  'enquiry',
] as const

export type PersonIntakeKind = (typeof PERSON_INTAKE_KINDS)[number]

export const PERSON_INTAKE_KIND_LABELS: Readonly<Record<PersonIntakeKind, string>> = {
  person: 'Person',
  company: 'Company',
  position: 'Position',
  note: 'Note',
  partnership: 'Partnership',
  deal: 'Deal',
  enquiry: 'Enquiry',
}

export const PERSON_INTAKE_RESULT_STATUSES = ['created', 'updated', 'linked', 'skipped', 'failed'] as const

export type PersonIntakeResultStatus = (typeof PERSON_INTAKE_RESULT_STATUSES)[number]

/** The key of the one Person item a proposal carries. Positions and notes attach to it. */
export const PERSON_INTAKE_PERSON_KEY = 'person'

/** The most pasted text one call accepts. A long email thread fits; a whole mailbox does not. */
export const PERSON_INTAKE_MAX_TEXT = 20_000

const text = z.string().trim()
const shortText = text.max(500)
const longText = text.max(8000)
const keySchema = z.string().trim().min(1).max(40)
const tagList = z.array(text.min(1).max(80)).max(20)

export const personIntakeSourceWireSchema = z.strictObject({
  url: z.url().max(2000),
  title: shortText,
})

// ---------------------------------------------------------------- identify

export const personIntakeExistingPersonWireSchema = z.strictObject({
  id: z.string().min(1),
  name: z.string(),
  email: z.string().nullable(),
})

export const personIntakeCandidateWireSchema = z.strictObject({
  key: keySchema,
  name: shortText.min(1),
  headline: shortText,
  company_name: shortText.nullable(),
  title: shortText.nullable(),
  location: shortText.nullable(),
  email: shortText.nullable(),
  profile_urls: z.array(z.url().max(2000)).max(10),
  evidence: longText,
  confidence: z.enum(PERSON_INTAKE_CONFIDENCES),
  existing_people: z.array(personIntakeExistingPersonWireSchema).max(10),
})

export type PersonIntakeCandidateWire = z.infer<typeof personIntakeCandidateWireSchema>

export const personIntakeIdentifyResponseWireSchema = z.strictObject({
  candidates: z.array(personIntakeCandidateWireSchema).max(5),
  question: longText.nullable(),
  sources: z.array(personIntakeSourceWireSchema),
  run_id: z.string().min(1),
})

// ---------------------------------------------------------------- items

export const personIntakePersonFieldsWireSchema = z.strictObject({
  name: shortText.min(1),
  first_name: shortText.nullable().optional(),
  last_name: shortText.nullable().optional(),
  email: shortText.nullable().optional(),
  phones: z.array(text.min(1).max(60)).max(10).optional(),
  social_profiles: z
    .array(z.strictObject({ network: z.enum(SOCIAL_NETWORK_IDS), url: z.url().max(2000) }))
    .max(10)
    .optional(),
  timezone: shortText.nullable().optional(),
  summary: longText.optional(),
  tags: tagList.optional(),
  preferred_channel: z.enum(PREFERRED_CHANNELS).optional(),
  influence: z.enum(INFLUENCE_LEVELS).optional(),
  relationship: z.enum(RELATIONSHIP_LEVELS).optional(),
})

export const personIntakeCompanyFieldsWireSchema = z.strictObject({
  name: shortText.min(1),
  domain: shortText.nullable().optional(),
  industry: shortText.nullable().optional(),
  description: longText.optional(),
  stage: z.enum(COMPANY_STAGES).optional(),
  size_band: z.enum(SIZE_BANDS).optional(),
  account_type: z.enum(ACCOUNT_TYPES).optional(),
  icp_fit: z.enum(ICP_FITS).optional(),
  tech_stack: z.array(text.min(1).max(80)).max(30).optional(),
  summary: longText.optional(),
  tags: tagList.optional(),
})

export const personIntakePartnershipFieldsWireSchema = z.strictObject({
  name: shortText.min(1),
  kind: shortText.optional(),
  goals: longText.optional(),
  summary: longText.optional(),
})

export const personIntakeDealFieldsWireSchema = z.strictObject({
  name: shortText.min(1),
  summary: longText.optional(),
})

export const personIntakeEnquiryFieldsWireSchema = z.strictObject({
  name: shortText.min(1),
  source: shortText.optional(),
  summary: longText.optional(),
})

export const personIntakeItemWireSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    key: keySchema,
    kind: z.literal('person'),
    action: z.enum(['create', 'update']),
    existing_id: z.string().min(1).nullable(),
    fields: personIntakePersonFieldsWireSchema,
  }),
  z.strictObject({
    key: keySchema,
    kind: z.literal('company'),
    action: z.enum(['create', 'existing']),
    existing_id: z.string().min(1).nullable(),
    fields: personIntakeCompanyFieldsWireSchema,
  }),
  z.strictObject({
    key: keySchema,
    kind: z.literal('position'),
    company_key: keySchema,
    title: shortText,
  }),
  z.strictObject({
    key: keySchema,
    kind: z.literal('note'),
    body: text.min(1).max(20_000),
  }),
  z.strictObject({
    key: keySchema,
    kind: z.literal('partnership'),
    company_key: keySchema,
    fields: personIntakePartnershipFieldsWireSchema,
    reason: longText,
  }),
  z.strictObject({
    key: keySchema,
    kind: z.literal('deal'),
    company_key: keySchema,
    fields: personIntakeDealFieldsWireSchema,
    reason: longText,
  }),
  z.strictObject({
    key: keySchema,
    kind: z.literal('enquiry'),
    company_key: keySchema.nullable(),
    fields: personIntakeEnquiryFieldsWireSchema,
    reason: longText,
  }),
])

export type PersonIntakeItemWire = z.infer<typeof personIntakeItemWireSchema>

export const personIntakeResearchResponseWireSchema = z.strictObject({
  summary: longText,
  items: z.array(personIntakeItemWireSchema).max(30),
  sources: z.array(personIntakeSourceWireSchema),
  run_id: z.string().min(1),
})

export const personIntakeResultWireSchema = z.strictObject({
  key: keySchema,
  kind: z.enum(PERSON_INTAKE_KINDS),
  status: z.enum(PERSON_INTAKE_RESULT_STATUSES),
  id: z.string().min(1).nullable(),
  label: z.string(),
  detail: z.string().nullable(),
})

export const personIntakeApplyResponseWireSchema = z.strictObject({
  results: z.array(personIntakeResultWireSchema),
})

// ---------------------------------------------------------------- decoded

export interface PersonIntakeSource {
  readonly url: string
  readonly title: string
}

export interface PersonIntakeExistingPerson {
  readonly id: string
  readonly name: string
  readonly email: string | null
}

export interface PersonIntakeCandidate {
  readonly key: string
  readonly name: string
  readonly headline: string
  readonly companyName: string | null
  readonly title: string | null
  readonly location: string | null
  readonly email: string | null
  readonly profileUrls: readonly string[]
  readonly evidence: string
  readonly confidence: PersonIntakeConfidence
  readonly existingPeople: readonly PersonIntakeExistingPerson[]
}

export interface PersonIntakeIdentifyResult {
  readonly candidates: readonly PersonIntakeCandidate[]
  readonly question: string | null
  readonly sources: readonly PersonIntakeSource[]
  readonly runId: string
}

export interface PersonIntakePersonFields {
  readonly name: string
  readonly firstName?: string | null | undefined
  readonly lastName?: string | null | undefined
  readonly email?: string | null | undefined
  readonly phones?: readonly string[] | undefined
  readonly socialProfiles?: readonly { readonly network: SocialNetworkId; readonly url: string }[] | undefined
  readonly timezone?: string | null | undefined
  readonly summary?: string | undefined
  readonly tags?: readonly string[] | undefined
  readonly preferredChannel?: PreferredChannel | undefined
  readonly influence?: Influence | undefined
  readonly relationship?: Relationship | undefined
}

export interface PersonIntakeCompanyFields {
  readonly name: string
  readonly domain?: string | null | undefined
  readonly industry?: string | null | undefined
  readonly description?: string | undefined
  readonly stage?: CompanyStage | undefined
  readonly sizeBand?: SizeBand | undefined
  readonly accountType?: AccountType | undefined
  readonly icpFit?: IcpFit | undefined
  readonly techStack?: readonly string[] | undefined
  readonly summary?: string | undefined
  readonly tags?: readonly string[] | undefined
}

export type PersonIntakeItem =
  | {
      readonly key: string
      readonly kind: 'person'
      readonly action: 'create' | 'update'
      readonly existingId: string | null
      readonly fields: PersonIntakePersonFields
    }
  | {
      readonly key: string
      readonly kind: 'company'
      readonly action: 'create' | 'existing'
      readonly existingId: string | null
      readonly fields: PersonIntakeCompanyFields
    }
  | { readonly key: string; readonly kind: 'position'; readonly companyKey: string; readonly title: string }
  | { readonly key: string; readonly kind: 'note'; readonly body: string }
  | {
      readonly key: string
      readonly kind: 'partnership'
      readonly companyKey: string
      readonly fields: {
        readonly name: string
        readonly kind?: string | undefined
        readonly goals?: string | undefined
        readonly summary?: string | undefined
      }
      readonly reason: string
    }
  | {
      readonly key: string
      readonly kind: 'deal'
      readonly companyKey: string
      readonly fields: { readonly name: string; readonly summary?: string | undefined }
      readonly reason: string
    }
  | {
      readonly key: string
      readonly kind: 'enquiry'
      readonly companyKey: string | null
      readonly fields: { readonly name: string; readonly source?: string | undefined; readonly summary?: string | undefined }
      readonly reason: string
    }

export interface PersonIntakeResearchResult {
  readonly summary: string
  readonly items: readonly PersonIntakeItem[]
  readonly sources: readonly PersonIntakeSource[]
  readonly runId: string
}

export interface PersonIntakeResult {
  readonly key: string
  readonly kind: PersonIntakeKind
  readonly status: PersonIntakeResultStatus
  readonly id: string | null
  readonly label: string
  readonly detail: string | null
}

export interface PersonIntakeApplyResult {
  readonly results: readonly PersonIntakeResult[]
}

function decodeCandidate(wire: PersonIntakeCandidateWire): PersonIntakeCandidate {
  return {
    key: wire.key,
    name: wire.name,
    headline: wire.headline,
    companyName: wire.company_name,
    title: wire.title,
    location: wire.location,
    email: wire.email,
    profileUrls: wire.profile_urls,
    evidence: wire.evidence,
    confidence: wire.confidence,
    existingPeople: wire.existing_people,
  }
}

function decodeItem(wire: PersonIntakeItemWire): PersonIntakeItem {
  switch (wire.kind) {
    case 'person': {
      const fields = wire.fields
      return {
        key: wire.key,
        kind: 'person',
        action: wire.action,
        existingId: wire.existing_id,
        fields: {
          name: fields.name,
          firstName: fields.first_name,
          lastName: fields.last_name,
          email: fields.email,
          phones: fields.phones,
          socialProfiles: fields.social_profiles,
          timezone: fields.timezone,
          summary: fields.summary,
          tags: fields.tags,
          preferredChannel: fields.preferred_channel,
          influence: fields.influence,
          relationship: fields.relationship,
        },
      }
    }
    case 'company': {
      const fields = wire.fields
      return {
        key: wire.key,
        kind: 'company',
        action: wire.action,
        existingId: wire.existing_id,
        fields: {
          name: fields.name,
          domain: fields.domain,
          industry: fields.industry,
          description: fields.description,
          stage: fields.stage,
          sizeBand: fields.size_band,
          accountType: fields.account_type,
          icpFit: fields.icp_fit,
          techStack: fields.tech_stack,
          summary: fields.summary,
          tags: fields.tags,
        },
      }
    }
    case 'position':
      return { key: wire.key, kind: 'position', companyKey: wire.company_key, title: wire.title }
    case 'note':
      return { key: wire.key, kind: 'note', body: wire.body }
    case 'partnership':
      return { key: wire.key, kind: 'partnership', companyKey: wire.company_key, fields: wire.fields, reason: wire.reason }
    case 'deal':
      return { key: wire.key, kind: 'deal', companyKey: wire.company_key, fields: wire.fields, reason: wire.reason }
    case 'enquiry':
      return { key: wire.key, kind: 'enquiry', companyKey: wire.company_key, fields: wire.fields, reason: wire.reason }
  }
}

export const personIntakeIdentifyResultSchema: z.ZodType<PersonIntakeIdentifyResult, unknown> =
  personIntakeIdentifyResponseWireSchema.transform(
    (wire): PersonIntakeIdentifyResult => ({
      candidates: wire.candidates.map(decodeCandidate),
      question: wire.question,
      sources: wire.sources,
      runId: wire.run_id,
    }),
  )

export const personIntakeResearchResultSchema: z.ZodType<PersonIntakeResearchResult, unknown> =
  personIntakeResearchResponseWireSchema.transform(
    (wire): PersonIntakeResearchResult => ({
      summary: wire.summary,
      items: wire.items.map(decodeItem),
      sources: wire.sources,
      runId: wire.run_id,
    }),
  )

export const personIntakeApplyResultSchema: z.ZodType<PersonIntakeApplyResult, unknown> =
  personIntakeApplyResponseWireSchema

// ---------------------------------------------------------------- bodies

export function personIntakeCandidateBody(candidate: PersonIntakeCandidate): PersonIntakeCandidateWire {
  return {
    key: candidate.key,
    name: candidate.name,
    headline: candidate.headline,
    company_name: candidate.companyName,
    title: candidate.title,
    location: candidate.location,
    email: candidate.email,
    profile_urls: [...candidate.profileUrls],
    evidence: candidate.evidence,
    confidence: candidate.confidence,
    existing_people: [...candidate.existingPeople],
  }
}

/** One item back to the wire, for `apply`. Absent fields stay absent. */
export function personIntakeItemBody(item: PersonIntakeItem): Record<string, unknown> {
  switch (item.kind) {
    case 'person':
      return {
        key: item.key,
        kind: item.kind,
        action: item.action,
        existing_id: item.existingId,
        fields: definedFields({
          name: item.fields.name,
          first_name: item.fields.firstName,
          last_name: item.fields.lastName,
          email: item.fields.email,
          phones: item.fields.phones,
          social_profiles: item.fields.socialProfiles,
          timezone: item.fields.timezone,
          summary: item.fields.summary,
          tags: item.fields.tags,
          preferred_channel: item.fields.preferredChannel,
          influence: item.fields.influence,
          relationship: item.fields.relationship,
        }),
      }
    case 'company':
      return {
        key: item.key,
        kind: item.kind,
        action: item.action,
        existing_id: item.existingId,
        fields: definedFields({
          name: item.fields.name,
          domain: item.fields.domain,
          industry: item.fields.industry,
          description: item.fields.description,
          stage: item.fields.stage,
          size_band: item.fields.sizeBand,
          account_type: item.fields.accountType,
          icp_fit: item.fields.icpFit,
          tech_stack: item.fields.techStack,
          summary: item.fields.summary,
          tags: item.fields.tags,
        }),
      }
    case 'position':
      return { key: item.key, kind: item.kind, company_key: item.companyKey, title: item.title }
    case 'note':
      return { key: item.key, kind: item.kind, body: item.body }
    case 'partnership':
    case 'deal':
      return {
        key: item.key,
        kind: item.kind,
        company_key: item.companyKey,
        fields: definedFields({ ...item.fields }),
        reason: item.reason,
      }
    case 'enquiry':
      return {
        key: item.key,
        kind: item.kind,
        company_key: item.companyKey,
        fields: definedFields({ ...item.fields }),
        reason: item.reason,
      }
  }
}

/**
 * The item keys `key` needs before it can be written: a Position needs its
 * Company and the Person, a Deal needs its Company. The UI disables a checkbox
 * whose dependency is unticked, and `apply` skips it the same way.
 */
export function personIntakeDependencies(item: PersonIntakeItem): readonly string[] {
  switch (item.kind) {
    case 'person':
    case 'company':
      return []
    case 'note':
      return [PERSON_INTAKE_PERSON_KEY]
    case 'position':
      return [PERSON_INTAKE_PERSON_KEY, item.companyKey]
    case 'partnership':
    case 'deal':
      return [PERSON_INTAKE_PERSON_KEY, item.companyKey]
    case 'enquiry':
      return item.companyKey === null ? [PERSON_INTAKE_PERSON_KEY] : [PERSON_INTAKE_PERSON_KEY, item.companyKey]
  }
}
