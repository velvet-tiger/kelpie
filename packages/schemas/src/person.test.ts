import { describe, expect, it } from 'vitest'

import { personBody, personSchema } from './person.ts'

function wirePerson(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'person_01hx',
    name: 'Ada Lovelace',
    salutation: null,
    first_name: 'Ada',
    last_name: 'Lovelace',
    suffix: null,
    email: 'ada@example.com',
    phones: ['+1 555 0100'],
    social_profiles: [{ network: 'linkedin', url: 'https://linkedin.com/in/ada' }],
    timezone: 'Europe/London',
    location: 'London, UK',
    preferred_channel: 'email',
    influence: 'decision_maker',
    relationship: 'warm',
    summary: 'Analytical Engine collaborator.',
    tags: ['engineering'],
    last_contacted_at: '2026-08-01T00:00:00.000Z',
    custom_fields: {},
    created_at: '2026-07-01T00:00:00.000Z',
    updated_at: '2026-08-01T00:00:00.000Z',
    ...overrides,
  }
}

describe('personSchema', () => {
  it('maps snake_case wire fields to the camelCase Person shape', () => {
    const person = personSchema.parse(wirePerson())

    expect(person).toEqual({
      id: 'person_01hx',
      name: 'Ada Lovelace',
      salutation: null,
      firstName: 'Ada',
      lastName: 'Lovelace',
      suffix: null,
      email: 'ada@example.com',
      phones: ['+1 555 0100'],
      socialProfiles: [{ network: 'linkedin', url: 'https://linkedin.com/in/ada' }],
      timezone: 'Europe/London',
      location: 'London, UK',
      preferredChannel: 'email',
      influence: 'decision_maker',
      relationship: 'warm',
      summary: 'Analytical Engine collaborator.',
      tags: ['engineering'],
      lastContactedAt: new Date('2026-08-01T00:00:00.000Z'),
      customFields: {},
      createdAt: new Date('2026-07-01T00:00:00.000Z'),
      updatedAt: new Date('2026-08-01T00:00:00.000Z'),
    })
  })

  it('parses custom_fields values by type and shapes currency to camelCase', () => {
    const person = personSchema.parse(
      wirePerson({
        custom_fields: {
          budget_owner: 'ada',
          headcount: 12,
          on_deck: true,
          regions: ['emea', 'apac'],
          budget: { amount_cents: 500000, currency: 'USD' },
        },
      }),
    )

    expect(person.customFields).toEqual({
      budget_owner: 'ada',
      headcount: 12,
      on_deck: true,
      regions: ['emea', 'apac'],
      budget: { amountCents: 500000, currency: 'USD' },
    })
  })

  it('carries nullable fields through as null rather than defaulting them', () => {
    const person = personSchema.parse(
      wirePerson({ email: null, timezone: null, location: null, last_contacted_at: null }),
    )

    expect(person.email).toBeNull()
    expect(person.timezone).toBeNull()
    expect(person.location).toBeNull()
    expect(person.lastContactedAt).toBeNull()
  })

  it('accepts empty arrays for phones, social profiles, and tags', () => {
    const person = personSchema.parse(wirePerson({ phones: [], social_profiles: [], tags: [] }))

    expect(person.phones).toEqual([])
    expect(person.socialProfiles).toEqual([])
    expect(person.tags).toEqual([])
  })

  it('rejects an influence value outside INFLUENCE_LEVELS', () => {
    expect(() => personSchema.parse(wirePerson({ influence: 'ceo' }))).toThrow()
  })

  it('rejects a social profile on a network the enum does not have', () => {
    expect(() =>
      personSchema.parse(wirePerson({ social_profiles: [{ network: 'friendster', url: 'x' }] })),
    ).toThrow()
  })

  it('rejects a missing required field', () => {
    const { name: _name, ...withoutName } = wirePerson()

    expect(() => personSchema.parse(withoutName)).toThrow()
  })

  it('carries a name part through as null when the person has none recorded', () => {
    const person = personSchema.parse(wirePerson({ first_name: null, last_name: null }))

    expect(person.firstName).toBeNull()
    expect(person.lastName).toBeNull()
    // The display name is untouched by an absent part. Nothing derives one from
    // the other on the way in, or anywhere else.
    expect(person.name).toBe('Ada Lovelace')
  })
})

describe('personBody', () => {
  it('sends only the fields that were set', () => {
    expect(personBody({ name: 'Ada Lovelace' })).toEqual({ name: 'Ada Lovelace' })
  })

  it('maps camelCase input back to snake_case wire keys', () => {
    const body = personBody({
      preferredChannel: 'call',
      socialProfiles: [{ network: 'github', url: 'https://github.com/ada' }],
    })

    expect(body).toEqual({
      preferred_channel: 'call',
      social_profiles: [{ network: 'github', url: 'https://github.com/ada' }],
    })
  })

  it('maps the name parts to their wire keys, and clears one with null', () => {
    expect(personBody({ firstName: 'Ada', lastName: 'Lovelace', salutation: null })).toEqual({
      first_name: 'Ada',
      last_name: 'Lovelace',
      salutation: null,
    })
  })

  it('sends an explicit null as a clear instruction, distinct from an absent field', () => {
    const body = personBody({ email: null })

    expect(body).toEqual({ email: null })
    expect('name' in body).toBe(false)
  })

  it('serialises lastContactedAt to an ISO string, and leaves null and undefined alone', () => {
    expect(personBody({ lastContactedAt: new Date('2026-08-01T00:00:00.000Z') })).toEqual({
      last_contacted_at: '2026-08-01T00:00:00.000Z',
    })
    expect(personBody({ lastContactedAt: null })).toEqual({ last_contacted_at: null })
    expect(personBody({})).toEqual({})
  })

  it('builds custom_fields with amountCents mapped back to amount_cents', () => {
    const body = personBody({
      customFields: {
        budget_owner: 'ada',
        budget: { amountCents: 500000, currency: 'USD' },
        headcount: null,
      },
    })

    expect(body).toEqual({
      custom_fields: {
        budget_owner: 'ada',
        budget: { amount_cents: 500000, currency: 'USD' },
        headcount: null,
      },
    })
  })
})
