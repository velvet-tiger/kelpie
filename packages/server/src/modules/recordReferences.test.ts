import { describe, expect, it } from 'vitest'

import { recordIdsIn } from './recordReferences.ts'

const ULID = '01M1DDZFG3N7TWB3F3X4AV4S96'

describe('recordIdsIn', () => {
  it('finds each record id once, in order, with its type', () => {
    expect(recordIdsIn(`prt_${ULID} then com_${ULID}, and prt_${ULID} again`)).toEqual([
      { targetType: 'partnership', targetId: `prt_${ULID}` },
      { targetType: 'company', targetId: `com_${ULID}` },
    ])
  })

  it('reads an event_ id as an Event, not a domain event', () => {
    expect(recordIdsIn(`event_${ULID} ev_${ULID}`)).toEqual([
      { targetType: 'event', targetId: `event_${ULID}` },
    ])
  })

  it('ignores ids that are not records, cut short, or inside a longer word', () => {
    expect(recordIdsIn(`key_${ULID}`)).toEqual([])
    expect(recordIdsIn(`prt_${ULID.slice(0, 20)}…`)).toEqual([])
    expect(recordIdsIn(`super_${ULID}`)).toEqual([])
    expect(recordIdsIn(`prt_${ULID}X`)).toEqual([])
  })

  it('reads Role and handbook page ids, which are not record targets', () => {
    expect(recordIdsIn(`role_${ULID} hb_${ULID}`)).toEqual([
      { targetType: 'role', targetId: `role_${ULID}` },
      { targetType: 'handbook_page', targetId: `hb_${ULID}` },
    ])
  })

  it('finds the id inside a [[type:id|Label]] link token', () => {
    expect(recordIdsIn(`See [[company:com_${ULID}|Acme]].`)).toEqual([
      { targetType: 'company', targetId: `com_${ULID}` },
    ])
  })

  it('finds nothing in no text', () => {
    expect(recordIdsIn(null)).toEqual([])
  })
})
