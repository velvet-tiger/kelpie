import { describe, expect, it } from 'vitest'

import {
  personIntakeCandidateWireSchema,
  personIntakePersonFieldsWireSchema,
  personIntakeSourceWireSchema,
} from './personIntake.ts'

/**
 * A model that read web pages writes these URLs, and the intake wizard puts
 * them in a link. So each accepts `http` and `https` and nothing else.
 */

const ACCEPTED = ['https://www.linkedin.com/in/dana-okafor', 'http://example.com/team?id=7#dana', 'http://localhost:3000/x']

const REFUSED = [
  'javascript:alert(1)',
  'JavaScript:alert(1)',
  'data:text/html,<script>alert(1)</script>',
  'file:///etc/passwd',
  'mailto:a@b.c',
  'ftp://example.com/dana.pdf',
  'example.com/dana',
]

function candidate(profileUrls: readonly string[]): Record<string, unknown> {
  return {
    key: 'c1',
    name: 'Dana Okafor',
    headline: 'Head of Platform at Northwind',
    company_name: 'Northwind',
    title: 'Head of Platform',
    location: null,
    email: null,
    profile_urls: profileUrls,
    evidence: 'Named in the notes.',
    confidence: 'high',
    existing_people: [],
  }
}

describe('personIntakeSourceWireSchema', () => {
  it.each(ACCEPTED)('accepts %s', (url) => {
    expect(personIntakeSourceWireSchema.safeParse({ url, title: 'A page' }).success).toBe(true)
  })

  it.each(REFUSED)('refuses %s', (url) => {
    expect(personIntakeSourceWireSchema.safeParse({ url, title: 'A page' }).success).toBe(false)
  })
})

describe('personIntakeCandidateWireSchema', () => {
  it.each(ACCEPTED)('accepts the profile URL %s', (url) => {
    expect(personIntakeCandidateWireSchema.safeParse(candidate([url])).success).toBe(true)
  })

  it.each(REFUSED)('refuses the profile URL %s', (url) => {
    expect(personIntakeCandidateWireSchema.safeParse(candidate([url])).success).toBe(false)
  })

  it('refuses the whole candidate for one bad profile URL among good ones', () => {
    const parsed = personIntakeCandidateWireSchema.safeParse(
      candidate(['https://www.linkedin.com/in/dana-okafor', 'javascript:alert(1)']),
    )

    expect(parsed.success).toBe(false)
  })
})

describe('personIntakePersonFieldsWireSchema', () => {
  it.each(ACCEPTED)('accepts the social profile %s', (url) => {
    const parsed = personIntakePersonFieldsWireSchema.safeParse({
      name: 'Dana Okafor',
      social_profiles: [{ network: 'linkedin', url }],
    })

    expect(parsed.success).toBe(true)
  })

  it.each(REFUSED)('refuses the social profile %s', (url) => {
    const parsed = personIntakePersonFieldsWireSchema.safeParse({
      name: 'Dana Okafor',
      social_profiles: [{ network: 'linkedin', url }],
    })

    expect(parsed.success).toBe(false)
  })
})
