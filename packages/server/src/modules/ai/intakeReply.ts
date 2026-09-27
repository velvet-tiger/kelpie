import {
  ACCOUNT_TYPES,
  COMPANY_STAGES,
  ICP_FITS,
  INFLUENCE_LEVELS,
  PERSON_INTAKE_CONFIDENCES,
  PERSON_INTAKE_PERSON_KEY,
  PREFERRED_CHANNELS,
  RELATIONSHIP_LEVELS,
  SIZE_BANDS,
  SOCIAL_NETWORK_IDS,
} from '@kelpie/schemas'
import type { PersonIntakeCandidateWire, PersonIntakeItemWire } from '@kelpie/schemas'
import { z } from 'zod'

import type { AiWebSource } from './provider.ts'

/**
 * What the model may reply to a person-intake call, and the pure steps that
 * turn a reply into the wire shape.
 *
 * The reply schemas are lenient where a model is likely to slip and the slip
 * costs nothing: a misspelt enum value, a URL without a scheme, a list that
 * runs long. Those fields `.catch()` to absent, so one bad value drops that
 * value, not the whole reply and a repair turn. What must be right (names,
 * the reply's overall shape) stays strict. The normalised result is then
 * parsed against the strict wire schema in `@kelpie/schemas` by the caller.
 *
 * No database and no model here, so every rule below is testable directly.
 */

const MAX_CANDIDATES = 3
const MAX_COMPANIES = 5
const MAX_PIPELINE_ITEMS = 3
const MAX_SOURCES = 12

const name = z.string().trim().min(1).max(500)
const optionalText = (max: number): z.ZodType<string | undefined> =>
  z.string().trim().max(max).optional().catch(undefined)
const nullableText = (max: number): z.ZodType<string | null> =>
  z.string().trim().max(max).nullable().default(null).catch(null)
const optionalEnum = <Values extends readonly [string, ...string[]]>(
  values: Values,
): z.ZodType<Values[number] | undefined> => z.enum(values).optional().catch(undefined)
const stringList = (max: number): z.ZodType<string[]> =>
  z.array(z.string().trim().min(1).max(200)).max(max).default([]).catch([])

const sourceReply = z.object({ url: z.string(), title: z.string().default('') })

const sourcesReply = z.array(sourceReply).default([]).catch([])

// ---------------------------------------------------------------- identify

const candidateReply = z.object({
  name,
  headline: z.string().trim().max(500).default(''),
  company_name: nullableText(500),
  title: nullableText(500),
  location: nullableText(500),
  email: nullableText(500),
  profile_urls: stringList(10),
  evidence: z.string().trim().max(8000).default(''),
  confidence: z.enum(PERSON_INTAKE_CONFIDENCES).catch('low'),
})

export const identifyReplySchema = z.object({
  candidates: z.array(candidateReply).default([]),
  question: nullableText(8000),
  sources: sourcesReply,
})

export type IdentifyReply = z.infer<typeof identifyReplySchema>

// ---------------------------------------------------------------- research

const personReply = z.object({
  name,
  first_name: nullableText(500),
  last_name: nullableText(500),
  email: nullableText(500),
  phones: stringList(10),
  social_profiles: z
    .array(z.object({ network: z.string(), url: z.string() }))
    .max(10)
    .default([])
    .catch([]),
  timezone: nullableText(100),
  summary: optionalText(8000),
  tags: stringList(20),
  preferred_channel: optionalEnum(PREFERRED_CHANNELS),
  influence: optionalEnum(INFLUENCE_LEVELS),
  relationship: optionalEnum(RELATIONSHIP_LEVELS),
})

const companyReply = z.object({
  ref: z.string().trim().min(1).max(40),
  existing_id: z.string().trim().min(1).nullable().default(null).catch(null),
  name,
  domain: nullableText(500),
  industry: nullableText(500),
  description: optionalText(8000),
  stage: optionalEnum(COMPANY_STAGES),
  size_band: optionalEnum(SIZE_BANDS),
  account_type: optionalEnum(ACCOUNT_TYPES),
  icp_fit: optionalEnum(ICP_FITS),
  tech_stack: stringList(30),
  summary: optionalText(8000),
  tags: stringList(20),
})

const reason = z.string().trim().max(8000).default('')

export const researchReplySchema = z.object({
  summary: z.string().trim().max(8000).default(''),
  person: personReply,
  companies: z.array(companyReply).default([]),
  positions: z
    .array(z.object({ company_ref: z.string().trim().min(1), title: z.string().trim().max(500).default('') }))
    .default([]),
  note: z.string().trim().max(16_000).default(''),
  partnerships: z
    .array(
      z.object({
        company_ref: z.string().trim().min(1),
        name,
        kind: optionalText(500),
        goals: optionalText(8000),
        summary: optionalText(8000),
        reason,
      }),
    )
    .default([]),
  deals: z
    .array(z.object({ company_ref: z.string().trim().min(1), name, summary: optionalText(8000), reason }))
    .default([]),
  enquiries: z
    .array(
      z.object({
        company_ref: z.string().trim().min(1).nullable().default(null),
        name,
        source: optionalText(500),
        summary: optionalText(8000),
        reason,
      }),
    )
    .default([]),
  sources: sourcesReply,
})

export type ResearchReply = z.infer<typeof researchReplySchema>

/** The JSON schemas advertised to the model. Advisory: the Zod parse above is the authority. */
export const IDENTIFY_REPLY_JSON_SCHEMA = z.toJSONSchema(identifyReplySchema, { io: 'input' }) as Record<string, unknown>
export const RESEARCH_REPLY_JSON_SCHEMA = z.toJSONSchema(researchReplySchema, { io: 'input' }) as Record<string, unknown>

// ---------------------------------------------------------------- normalise

/** An absolute http(s) URL, or undefined. A bare `linkedin.com/in/…` gains `https://`. */
export function normaliseUrl(raw: string): string | undefined {
  const trimmed = raw.trim()

  if (trimmed.length === 0 || trimmed.length > 2000) {
    return undefined
  }

  const withScheme = /^https?:\/\//iu.test(trimmed) ? trimmed : `https://${trimmed}`

  try {
    const url = new URL(withScheme)

    // Credentials in a URL are never a profile or a source; `mailto:a@b`
    // with a scheme prepended would otherwise read as one.
    if (url.username !== '' || url.password !== '') {
      return undefined
    }

    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : undefined
  } catch {
    return undefined
  }
}

/** The key a URL is compared by: no scheme, no `www.`, no trailing slash, no fragment. */
function urlKey(url: string): string {
  try {
    const parsed = new URL(url)
    const host = parsed.hostname.replace(/^www\./u, '')
    const path = parsed.pathname.replace(/\/+$/u, '')

    return `${host}${path}${parsed.search}`.toLowerCase()
  } catch {
    return url.toLowerCase()
  }
}

/**
 * The sources worth keeping: valid URLs, no duplicates, and, when the call
 * searched the web, only URLs the search actually returned. A model can cite
 * a plausible page that does not exist; this keeps it out of the note.
 *
 * With no search, the model can only cite what the user pasted, so the
 * pasted text is the allow-list instead.
 */
export function keepSources(
  cited: readonly { readonly url: string; readonly title: string }[],
  searched: readonly AiWebSource[] | undefined,
  pastedText: string,
): { url: string; title: string }[] {
  const allowed = new Map<string, string>()

  for (const source of searched ?? []) {
    const url = normaliseUrl(source.url)
    if (url !== undefined) {
      allowed.set(urlKey(url), source.title)
    }
  }

  const pasted = pastedText.toLowerCase()
  const kept = new Map<string, { url: string; title: string }>()

  for (const source of cited) {
    const url = normaliseUrl(source.url)
    if (url === undefined) continue

    const key = urlKey(url)
    const searchedTitle = allowed.get(key)
    const seen = searchedTitle !== undefined || pasted.includes(key)

    if (!seen || kept.has(key)) continue

    const title = source.title.trim() || searchedTitle || url
    kept.set(key, { url, title: title.slice(0, 500) })
  }

  return [...kept.values()].slice(0, MAX_SOURCES)
}

/** Identify's candidates as the wire has them, before the CRM lookup fills `existing_people`. */
export function normaliseCandidates(reply: IdentifyReply): PersonIntakeCandidateWire[] {
  return reply.candidates.slice(0, MAX_CANDIDATES).map((candidate, index) => ({
    key: `c${String(index + 1)}`,
    name: candidate.name,
    headline: candidate.headline,
    company_name: candidate.company_name,
    title: candidate.title,
    location: candidate.location,
    email: candidate.email,
    profile_urls: candidate.profile_urls.flatMap((raw) => {
      const url = normaliseUrl(raw)
      return url === undefined ? [] : [url]
    }),
    evidence: candidate.evidence,
    confidence: candidate.confidence,
    existing_people: [],
  }))
}

export interface ResearchNormaliseInput {
  readonly reply: ResearchReply
  /** The Person the user chose to update, or null for a new one. */
  readonly existingPersonId: string | null
  /** The Company ids Kelpie offered the model. Any other id becomes a create. */
  readonly offeredCompanyIds: ReadonlySet<string>
  /** `company_id:title` pairs the existing Person already holds, so they are not proposed twice. */
  readonly heldPositions: ReadonlySet<string>
  readonly sources: readonly { readonly url: string; readonly title: string }[]
}

const SOCIAL_NETWORKS: ReadonlySet<string> = new Set(SOCIAL_NETWORK_IDS)

function withoutUndefined<Shape extends Record<string, unknown>>(shape: Shape): Shape {
  return Object.fromEntries(Object.entries(shape).filter(([, value]) => value !== undefined)) as Shape
}

function nonEmpty<Value>(list: readonly Value[]): readonly Value[] | undefined {
  return list.length === 0 ? undefined : list
}

/** Research's reply as the flat, keyed item list the checkboxes show. */
export function normaliseResearch(input: ResearchNormaliseInput): PersonIntakeItemWire[] {
  const { reply } = input
  const items: PersonIntakeItemWire[] = []
  const person = reply.person

  items.push({
    key: PERSON_INTAKE_PERSON_KEY,
    kind: 'person',
    action: input.existingPersonId === null ? 'create' : 'update',
    existing_id: input.existingPersonId,
    fields: withoutUndefined({
      name: person.name,
      first_name: person.first_name ?? undefined,
      last_name: person.last_name ?? undefined,
      email: person.email ?? undefined,
      phones: nonEmpty(person.phones),
      social_profiles: nonEmpty(
        person.social_profiles.flatMap((profile) => {
          const url = normaliseUrl(profile.url)
          const network = profile.network.trim().toLowerCase()
          return url === undefined || !SOCIAL_NETWORKS.has(network)
            ? []
            : [{ network: network as (typeof SOCIAL_NETWORK_IDS)[number], url }]
        }),
      ),
      timezone: person.timezone ?? undefined,
      summary: person.summary === '' ? undefined : person.summary,
      tags: nonEmpty(person.tags),
      preferred_channel: person.preferred_channel,
      influence: person.influence,
      relationship: person.relationship,
    }) as Extract<PersonIntakeItemWire, { kind: 'person' }>['fields'],
  })

  // Company refs the model chose map to keys Kelpie chose, so a model ref
  // that happens to read "person" cannot collide with the Person's key.
  const companyKeys = new Map<string, string>()
  const companyIdsByKey = new Map<string, string>()

  for (const company of reply.companies.slice(0, MAX_COMPANIES)) {
    if (companyKeys.has(company.ref)) continue

    const key = `co${String(companyKeys.size + 1)}`
    const existingId =
      company.existing_id !== null && input.offeredCompanyIds.has(company.existing_id) ? company.existing_id : null

    companyKeys.set(company.ref, key)
    if (existingId !== null) companyIdsByKey.set(key, existingId)

    items.push({
      key,
      kind: 'company',
      action: existingId === null ? 'create' : 'existing',
      existing_id: existingId,
      fields: withoutUndefined({
        name: company.name,
        domain: company.domain ?? undefined,
        industry: company.industry ?? undefined,
        description: company.description === '' ? undefined : company.description,
        stage: company.stage,
        size_band: company.size_band,
        account_type: company.account_type,
        icp_fit: company.icp_fit,
        tech_stack: nonEmpty(company.tech_stack),
        summary: company.summary === '' ? undefined : company.summary,
        tags: nonEmpty(company.tags),
      }) as Extract<PersonIntakeItemWire, { kind: 'company' }>['fields'],
    })
  }

  const positionPairs = new Set<string>()

  for (const position of reply.positions) {
    const companyKey = companyKeys.get(position.company_ref)
    if (companyKey === undefined) continue

    const existingCompanyId = companyIdsByKey.get(companyKey)
    const pair = `${companyKey}:${position.title.toLowerCase()}`
    const held =
      existingCompanyId !== undefined && input.heldPositions.has(`${existingCompanyId}:${position.title.toLowerCase()}`)

    if (held || positionPairs.has(pair)) continue
    positionPairs.add(pair)

    items.push({ key: `pos${String(positionPairs.size)}`, kind: 'position', company_key: companyKey, title: position.title })
  }

  const note = renderNote(reply.note, input.sources)
  if (note !== null) {
    items.push({ key: 'note', kind: 'note', body: note })
  }

  reply.partnerships.slice(0, MAX_PIPELINE_ITEMS).forEach((partnership, index) => {
    const companyKey = companyKeys.get(partnership.company_ref)
    if (companyKey === undefined) return

    items.push({
      key: `pa${String(index + 1)}`,
      kind: 'partnership',
      company_key: companyKey,
      fields: withoutUndefined({
        name: partnership.name,
        kind: partnership.kind,
        goals: partnership.goals,
        summary: partnership.summary,
      }) as Extract<PersonIntakeItemWire, { kind: 'partnership' }>['fields'],
      reason: partnership.reason,
    })
  })

  reply.deals.slice(0, MAX_PIPELINE_ITEMS).forEach((deal, index) => {
    const companyKey = companyKeys.get(deal.company_ref)
    if (companyKey === undefined) return

    items.push({
      key: `de${String(index + 1)}`,
      kind: 'deal',
      company_key: companyKey,
      fields: withoutUndefined({ name: deal.name, summary: deal.summary }) as Extract<
        PersonIntakeItemWire,
        { kind: 'deal' }
      >['fields'],
      reason: deal.reason,
    })
  })

  reply.enquiries.slice(0, MAX_PIPELINE_ITEMS).forEach((enquiry, index) => {
    const companyKey = enquiry.company_ref === null ? null : (companyKeys.get(enquiry.company_ref) ?? null)

    items.push({
      key: `en${String(index + 1)}`,
      kind: 'enquiry',
      company_key: companyKey,
      fields: withoutUndefined({ name: enquiry.name, source: enquiry.source, summary: enquiry.summary }) as Extract<
        PersonIntakeItemWire,
        { kind: 'enquiry' }
      >['fields'],
      reason: enquiry.reason,
    })
  })

  return items
}

/** The pinned research note: the model's text, then the sources Kelpie kept. */
export function renderNote(
  body: string,
  sources: readonly { readonly url: string; readonly title: string }[],
): string | null {
  const text = body.trim()

  if (text.length === 0 && sources.length === 0) {
    return null
  }

  const lines = text.length === 0 ? [] : [text]

  if (sources.length > 0) {
    lines.push('', '**Sources**', ...sources.map((source) => `- [${source.title.replace(/[[\]]/gu, '')}](${source.url})`))
  }

  return lines.join('\n').trim()
}
