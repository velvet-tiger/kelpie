import { describe, expect, it } from 'vitest'

import { DASHBOARD_GET_DESCRIPTION } from './tools.ts'

/**
 * The two windows are stated in the tool text, so an agent does not have to
 * guess them from the response. The numbers are written out here on purpose:
 * changing a window must also change this test and the description it guards.
 */
describe('dashboard_get description', () => {
  it('states the 14-day stale window', () => {
    expect(DASHBOARD_GET_DESCRIPTION).toContain('A stale contact has gone 14 days without contact.')
  })

  it('states the 7-day due-soon window', () => {
    expect(DASHBOARD_GET_DESCRIPTION).toContain('due soon within 7 days')
  })

  it('says the windows are fixed and names the echoed fields', () => {
    expect(DASHBOARD_GET_DESCRIPTION).toContain('Both windows are fixed.')
    expect(DASHBOARD_GET_DESCRIPTION).toContain('stale_contact_days and upcoming_days')
  })
})
