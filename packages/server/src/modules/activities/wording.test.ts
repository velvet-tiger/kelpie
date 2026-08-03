import { describe, expect, it } from 'vitest'

import {
  describeCreation,
  describeLink,
  describeNote,
  describeStageChange,
  describeUnlink,
  describeUpdate,
} from './wording.ts'
import type { FieldLabels } from './wording.ts'

/** What a timeline row says. Pure, so it gets asserted here rather than through the API. */

const LABELS: FieldLabels = {
  influence: 'Influence',
  preferredChannel: 'Preferred channel',
  relationship: 'Relationship',
  tags: 'Tags',
  lastContactedAt: 'Last contacted',
}

describe('describeCreation', () => {
  it('names the object', () => {
    expect(describeCreation('Person')).toEqual({ action: 'created Person', detail: null })
  })
})

describe('describeUpdate', () => {
  it('names one changed field and shows what it moved between', () => {
    const wording = describeUpdate(
      ['influence'],
      LABELS,
      { influence: 'influencer' },
      { influence: 'decision_maker' },
    )

    expect(wording).toEqual({
      action: 'changed Influence',
      detail: 'influencer → decision_maker',
    })
  })

  it('counts several changed fields and lists them', () => {
    const wording = describeUpdate(
      ['preferredChannel', 'relationship'],
      LABELS,
      { preferredChannel: 'email', relationship: 'cold' },
      { preferredChannel: 'call', relationship: 'warm' },
    )

    expect(wording).toEqual({
      action: 'changed 2 attributes',
      detail: 'Preferred channel, Relationship',
    })
  })

  it('renders an empty string and a null as "none" rather than as nothing', () => {
    const wording = describeUpdate(['relationship'], LABELS, { relationship: null }, { relationship: 'warm' })

    expect(wording.detail).toBe('none → warm')
  })

  it('omits the before-and-after for a value that has no short rendering', () => {
    const wording = describeUpdate(['tags'], LABELS, { tags: ['a'] }, { tags: ['a', 'b'] })

    expect(wording).toEqual({ action: 'changed Tags', detail: null })
  })

  it('shows a timestamp change', () => {
    const wording = describeUpdate(
      ['lastContactedAt'],
      LABELS,
      { lastContactedAt: null },
      { lastContactedAt: new Date('2026-08-03T01:00:00.000Z') },
    )

    expect(wording.detail).toBe('none → 2026-08-03T01:00:00.000Z')
  })

  it('falls back to the field name when a label is missing', () => {
    expect(describeUpdate(['whatever'], LABELS, {}, { whatever: 'x' }).action).toBe('changed whatever')
  })
})

describe('describeLink', () => {
  it('names the relation and the far side', () => {
    expect(describeLink('company', 'Analytical Engines')).toEqual({
      action: 'linked to company',
      detail: 'Analytical Engines',
    })
  })
})

describe('describeUnlink', () => {
  it('names the relation and the far side', () => {
    expect(describeUnlink('company', 'Analytical Engines')).toEqual({
      action: 'unlinked from company',
      detail: 'Analytical Engines',
    })
  })
})

describe('describeStageChange', () => {
  it('leads with where it landed', () => {
    expect(describeStageChange('Qualifying', 'Proposal')).toEqual({
      action: 'moved to Proposal',
      detail: 'Qualifying → Proposal',
    })
  })
})

describe('describeNote', () => {
  it('quotes a short note whole', () => {
    expect(describeNote('  Cares about implementation.  ')).toEqual({
      action: 'added a note',
      detail: 'Cares about implementation.',
    })
  })

  it('truncates a long one', () => {
    const wording = describeNote('x'.repeat(200))

    expect(wording.detail).toBe(`${'x'.repeat(120)}…`)
  })

  it('carries no detail for a note that is only whitespace', () => {
    expect(describeNote('   ').detail).toBeNull()
  })
})
