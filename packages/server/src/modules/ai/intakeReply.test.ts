import { personIntakeItemWireSchema } from '@kelpie/schemas'
import { describe, expect, it } from 'vitest'

import { mergePersonUpdate } from './intake.ts'
import { keepSources, normaliseResearch, normaliseUrl, renderNote, researchReplySchema } from './intakeReply.ts'

/** The pure rules that turn a person-intake reply into the wire shape. */

describe('normaliseUrl', () => {
  it('adds a scheme to a bare host and refuses what is not a web URL', () => {
    expect(normaliseUrl('linkedin.com/in/dana')).toBe('https://linkedin.com/in/dana')
    expect(normaliseUrl('  https://example.com/a  ')).toBe('https://example.com/a')
    expect(normaliseUrl('mailto:dana@example.com')).toBeUndefined()
    expect(normaliseUrl('javascript:alert(1)')).toBeUndefined()
    expect(normaliseUrl('not a url')).toBeUndefined()
    expect(normaliseUrl('')).toBeUndefined()
  })

  it('never answers a non-http scheme', () => {
    for (const raw of ['javascript:alert(1)', 'ftp://example.com/file', 'data:text/html,hi']) {
      const url = normaliseUrl(raw)
      expect(url === undefined || url.startsWith('https://')).toBe(true)
    }
  })
})

describe('keepSources', () => {
  it('keeps a cited URL only when the search returned it, matching loosely', () => {
    const kept = keepSources(
      [
        { url: 'https://brightline.health/team', title: '' },
        { url: 'https://invented.example/page', title: 'Invented' },
        { url: 'brightline.health/team/', title: 'Duplicate' },
      ],
      [{ url: 'https://www.brightline.health/team/', title: 'Brightline team' }],
      '',
    )

    expect(kept).toEqual([{ url: 'https://brightline.health/team', title: 'Brightline team' }])
  })

  it('uses the pasted notes as the allow-list when there was no search', () => {
    const kept = keepSources(
      [
        { url: 'https://brightline.health/team', title: 'Team' },
        { url: 'https://elsewhere.example/', title: 'Elsewhere' },
      ],
      undefined,
      'See https://brightline.health/team for more',
    )

    expect(kept).toEqual([{ url: 'https://brightline.health/team', title: 'Team' }])
  })
})

describe('renderNote', () => {
  it('appends the sources, and strips brackets that would break the link', () => {
    expect(renderNote('Found things.', [{ url: 'https://a.example/', title: 'A [draft]' }])).toBe(
      'Found things.\n\n**Sources**\n- [A draft](https://a.example/)',
    )
    expect(renderNote('  ', [])).toBeNull()
  })
})

describe('normaliseResearch', () => {
  const base = {
    person: { name: 'Dana Reyes' },
    companies: [
      { ref: 'person', name: 'Brightline', existing_id: 'com_1' },
      { ref: 'b', name: 'Other', existing_id: 'com_2' },
    ],
    positions: [
      { company_ref: 'person', title: 'CTO' },
      { company_ref: 'person', title: 'cto' },
      { company_ref: 'b', title: 'Advisor' },
    ],
    enquiries: [{ company_ref: 'unknown', name: 'Inbound', reason: 'Asked' }],
  }

  it('keys every item, keeps offered ids only, drops duplicates and positions already held', () => {
    const items = normaliseResearch({
      reply: researchReplySchema.parse(base),
      existingPersonId: 'per_1',
      offeredCompanyIds: new Set(['com_1']),
      heldPositions: new Set(),
      sources: [],
    })

    expect(items.map((item) => item.key)).toEqual(['person', 'co1', 'co2', 'pos1', 'pos2', 'en1'])
    expect(items[0]).toMatchObject({ action: 'update', existing_id: 'per_1' })
    // A model ref of "person" still maps to a company key, not the Person's.
    expect(items[1]).toMatchObject({ key: 'co1', action: 'existing', existing_id: 'com_1' })
    expect(items[2]).toMatchObject({ key: 'co2', action: 'create', existing_id: null })
    // An enquiry with an unknown company keeps going without one.
    expect(items[5]).toMatchObject({ kind: 'enquiry', company_key: null })

    for (const item of items) {
      expect(personIntakeItemWireSchema.safeParse(item).success).toBe(true)
    }
  })

  it('does not propose a position the existing person holds', () => {
    const items = normaliseResearch({
      reply: researchReplySchema.parse(base),
      existingPersonId: 'per_1',
      offeredCompanyIds: new Set(['com_1']),
      heldPositions: new Set(['com_1:cto']),
      sources: [],
    })

    expect(items.filter((item) => item.kind === 'position')).toEqual([
      { key: 'pos1', kind: 'position', company_key: 'co2', title: 'Advisor' },
    ])
  })

  it('drops a bad enum or social network rather than failing the reply', () => {
    const reply = researchReplySchema.parse({
      person: {
        name: 'Dana',
        influence: 'kingmaker',
        social_profiles: [
          { network: 'LinkedIn', url: 'linkedin.com/in/dana' },
          { network: 'friendster', url: 'https://friendster.example/dana' },
        ],
      },
      companies: [{ ref: 'a', name: 'Co', size_band: 'huge' }],
    })
    const [person, company] = normaliseResearch({
      reply,
      existingPersonId: null,
      offeredCompanyIds: new Set(),
      heldPositions: new Set(),
      sources: [],
    })

    expect(person).toMatchObject({
      fields: { name: 'Dana', social_profiles: [{ network: 'linkedin', url: 'https://linkedin.com/in/dana' }] },
    })
    expect(person?.kind === 'person' ? person.fields.influence : 'wrong kind').toBeUndefined()
    expect(company?.kind === 'company' ? company.fields.size_band : 'wrong kind').toBeUndefined()
  })
})

describe('mergePersonUpdate', () => {
  it('fills blanks, unions lists, and leaves the name and filled fields alone', () => {
    const update = mergePersonUpdate(
      {
        name: 'Dana R.',
        email: null,
        summary: 'Keep',
        timezone: '',
        tags: ['Investor'],
        phones: [],
        social_profiles: [{ network: 'linkedin', url: 'https://linkedin.com/in/old' }],
      },
      {
        name: 'Dana Reyes',
        email: 'dana@example.com',
        summary: 'Replace',
        timezone: 'America/Chicago',
        tags: ['investor', 'hlth'],
        social_profiles: [
          { network: 'linkedin', url: 'https://linkedin.com/in/new' },
          { network: 'github', url: 'https://github.com/dana' },
        ],
      },
    )

    expect(update).toEqual({
      email: 'dana@example.com',
      timezone: 'America/Chicago',
      tags: ['Investor', 'hlth'],
      social_profiles: [
        { network: 'linkedin', url: 'https://linkedin.com/in/old' },
        { network: 'github', url: 'https://github.com/dana' },
      ],
    })
  })

  it('answers nothing when there is nothing new', () => {
    expect(mergePersonUpdate({ name: 'Dana', tags: ['a'] }, { name: 'Dana', tags: ['A'] })).toEqual({})
  })
})
