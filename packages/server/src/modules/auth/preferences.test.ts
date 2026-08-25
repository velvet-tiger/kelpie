import { describe, expect, it } from 'vitest'

import { DEFAULT_PREFERENCES, applyPreferenceChanges } from './preferences.ts'

/**
 * The fold a `PATCH /v1/account/preferences` performs, on its own. The endpoint
 * test covers the round trip; these cover the rules that decide the row.
 */

describe('applyPreferenceChanges', () => {
  const stored = {
    timezone: 'Australia/Sydney',
    theme: 'dark',
    emailDigest: false,
    mentionEmails: false,
    productUpdates: true,
    listViews: { people: { columns: ['name', 'position'] } },
  } as const

  it('answers the defaults when nothing is stored and nothing changed', () => {
    expect(applyPreferenceChanges(undefined, {})).toEqual(DEFAULT_PREFERENCES)
  })

  it('fills the fields a first save leaves out from the defaults', () => {
    expect(applyPreferenceChanges(undefined, { timezone: 'Europe/London' })).toEqual({
      ...DEFAULT_PREFERENCES,
      timezone: 'Europe/London',
    })
  })

  it('leaves stored values alone when the change does not name them', () => {
    expect(applyPreferenceChanges(stored, { theme: 'light' })).toEqual({
      ...stored,
      theme: 'light',
    })
  })

  it('applies false, rather than treating it as an absent field', () => {
    expect(applyPreferenceChanges({ ...stored, emailDigest: true }, { emailDigest: false })).toEqual({
      ...stored,
      emailDigest: false,
    })
  })

  it('produces the same row when the same change is applied twice', () => {
    const once = applyPreferenceChanges(stored, { timezone: 'UTC', productUpdates: false })

    expect(applyPreferenceChanges(once, { timezone: 'UTC', productUpdates: false })).toEqual(once)
  })

  it('replaces the whole listViews map rather than merging by key', () => {
    // Merging is the client's job: it PATCHes the map it wants to store, so a
    // key it dropped should stay dropped.
    const changed = applyPreferenceChanges(stored, {
      listViews: { companies: { columns: ['name', 'stage'] } },
    })

    expect(changed.listViews).toEqual({ companies: { columns: ['name', 'stage'] } })
  })

  it('leaves listViews alone when the change does not name it', () => {
    expect(applyPreferenceChanges(stored, { theme: 'light' }).listViews).toEqual(stored.listViews)
  })
})
