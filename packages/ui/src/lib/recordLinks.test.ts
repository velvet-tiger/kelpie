import { describe, expect, it } from 'vitest'

import { referenceHref, targetHref } from './recordLinks.ts'

describe('targetHref', () => {
  it('points at the record for every type that has a page', () => {
    expect(targetHref('person', 'per_1')).toBe('/people/per_1')
    expect(targetHref('raise', 'rse_1')).toBe('/fundraising/rse_1')
    expect(targetHref('event', 'event_1')).toBe('/events/event_1')
    expect(targetHref('role', 'role_1')).toBe('/hiring/role_1')
    expect(targetHref('handbook_page', 'hb_1')).toBe('/handbook/hb_1')
  })

  it('has none for a candidate, which is reached through its Role', () => {
    expect(targetHref('candidate', 'cand_1')).toBeUndefined()
  })
})

describe('referenceHref', () => {
  it('opens a list and a form on their own pages', () => {
    expect(referenceHref({ targetType: 'list', targetId: 'list_1', name: 'Leads', parent: null })).toBe(
      '/lists/list_1',
    )
    expect(referenceHref({ targetType: 'form', targetId: 'form_1', name: 'Signup', parent: null })).toBe(
      '/forms/form_1',
    )
  })

  it('opens a note on the page of the record it is on, at the note', () => {
    expect(
      referenceHref({
        targetType: 'note',
        targetId: 'note_1',
        name: 'Pricing call',
        parent: { type: 'company', id: 'com_1' },
      }),
    ).toBe('/companies/com_1#note_1')
  })

  it('has nowhere to open a note whose record has no page', () => {
    expect(
      referenceHref({
        targetType: 'note',
        targetId: 'note_1',
        name: 'x',
        parent: { type: 'candidate', id: 'cand_1' },
      }),
    ).toBeUndefined()
  })
})
