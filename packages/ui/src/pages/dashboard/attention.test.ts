import type {
  Dashboard,
  DashboardPlanItem,
  DashboardSignal,
  DashboardStaleContact,
  DashboardTouchpoint,
} from '@kelpie/schemas'
import { describe, expect, it } from 'vitest'

import { attentionRows, briefLines, targetDescription, targetHref } from './attention.ts'

/** The empty snapshot every case below adds one signal to. */
function emptySignal<Item>(): DashboardSignal<Item> {
  return { total: 0, items: [] }
}

function dashboard(overrides: Partial<Dashboard> = {}): Dashboard {
  return {
    generatedAt: new Date('2026-06-15T23:30:00.000Z'),
    today: '2026-06-16',
    timezone: 'Australia/Melbourne',
    staleContactDays: 14,
    upcomingDays: 7,
    pipelines: [
      { kind: 'deal', open: 0 },
      { kind: 'opportunity', open: 0 },
      { kind: 'raise', open: 0 },
      { kind: 'partnership', open: 0 },
    ],
    overduePlanItems: emptySignal<DashboardPlanItem>(),
    dueSoonPlanItems: emptySignal<DashboardPlanItem>(),
    partnershipTouchpoints: emptySignal<DashboardTouchpoint>(),
    staleContacts: emptySignal<DashboardStaleContact>(),
    recentActivity: [],
    recentNotes: [],
    recentDecisions: [],
    ...overrides,
  }
}

function planItem(overrides: Partial<DashboardPlanItem> = {}): DashboardPlanItem {
  return {
    id: 'plan_1',
    targetType: 'deal',
    targetId: 'deal_1',
    targetName: 'Engine rollout',
    date: '2026-06-10',
    title: 'Send the revised terms',
    ownerId: null,
    status: 'todo',
    ...overrides,
  }
}

function touchpoint(overrides: Partial<DashboardTouchpoint> = {}): DashboardTouchpoint {
  return {
    id: 'prt_1',
    name: 'Northwind reseller',
    companyId: 'com_1',
    nextTouchpoint: '2026-06-18',
    overdue: false,
    ownerId: null,
    summary: 'Quarterly check-in',
    ...overrides,
  }
}

function staleContact(overrides: Partial<DashboardStaleContact> = {}): DashboardStaleContact {
  return {
    id: 'per_1',
    name: 'Ada Lovelace',
    email: 'ada@example.com',
    lastContactedAt: new Date('2026-05-01T00:00:00.000Z'),
    daysSinceContact: 46,
    summary: 'Champion at Northwind',
    ...overrides,
  }
}

describe('targetHref', () => {
  it('points at the record for every type that has a page', () => {
    expect(targetHref('person', 'per_1')).toBe('/people/per_1')
    expect(targetHref('raise', 'rse_1')).toBe('/fundraising/rse_1')
  })

  it('has none for a candidate, which is reached through its Role', () => {
    expect(targetHref('candidate', 'cand_1')).toBeUndefined()
  })
})

describe('targetDescription', () => {
  it('names the type and the record', () => {
    expect(targetDescription({ targetType: 'deal', targetName: 'Engine rollout' })).toBe(
      'Deal · Engine rollout',
    )
  })

  it('falls back to the type alone when the target no longer resolves', () => {
    expect(targetDescription({ targetType: 'deal', targetName: null })).toBe('Deal')
  })
})

describe('attentionRows', () => {
  it('leads with what is late, then what is near, then what has gone quiet', () => {
    const rows = attentionRows(
      dashboard({
        overduePlanItems: { total: 1, items: [planItem({ id: 'plan_late' })] },
        dueSoonPlanItems: { total: 1, items: [planItem({ id: 'plan_soon', date: '2026-06-18' })] },
        partnershipTouchpoints: {
          total: 2,
          items: [
            touchpoint({ id: 'prt_late', overdue: true, nextTouchpoint: '2026-06-12' }),
            touchpoint({ id: 'prt_soon' }),
          ],
        },
        staleContacts: { total: 1, items: [staleContact()] },
      }),
    )

    expect(rows.map((row) => row.label)).toEqual([
      'Plan item overdue',
      'Touchpoint overdue',
      'Plan item due soon',
      'Touchpoint soon',
      'Stale contact',
    ])
    expect(rows.map((row) => row.tone)).toEqual([
      'danger',
      'danger',
      'warning',
      'warning',
      'neutral',
    ])
  })

  it('names the record a plan item is on, and links to it', () => {
    const [row] = attentionRows(
      dashboard({ overduePlanItems: { total: 1, items: [planItem()] } }),
    )

    expect(row?.title).toBe('Send the revised terms')
    expect(row?.detail).toBe('Deal · Engine rollout')
    expect(row?.href).toBe('/deals/deal_1')
  })

  it('writes how long a contact has been quiet', () => {
    const [row] = attentionRows(
      dashboard({ staleContacts: { total: 1, items: [staleContact()] } }),
    )

    expect(row?.meta).toBe('46 days since contact')
  })

  it('is empty when nothing needs attention', () => {
    expect(attentionRows(dashboard())).toEqual([])
  })
})

describe('briefLines', () => {
  it('says so plainly when there is nothing to do', () => {
    expect(briefLines(dashboard())).toEqual([
      'Nothing urgent. Pipeline and relationships look quiet today.',
    ])
  })

  it('counts from the totals, not from the rows the request asked for', () => {
    const [line] = briefLines(
      dashboard({ overduePlanItems: { total: 12, items: [planItem()] } }),
    )

    expect(line).toBe('12 plan items overdue — triage Planning first.')
  })

  it('agrees with itself on one', () => {
    const [line] = briefLines(dashboard({ staleContacts: { total: 1, items: [] } }))

    expect(line).toBe('1 contact past the 14-day touch threshold.')
  })

  it('lists the open pipelines with the right nouns, and skips the empty ones', () => {
    const lines = briefLines(
      dashboard({
        pipelines: [
          { kind: 'deal', open: 3 },
          { kind: 'opportunity', open: 2 },
          { kind: 'raise', open: 1 },
          { kind: 'partnership', open: 0 },
        ],
      }),
    )

    expect(lines).toEqual(['Open: 3 deals, 2 opportunities, 1 raise.'])
  })

  it('reads the window length off the response rather than assuming a week', () => {
    const lines = briefLines(
      dashboard({ dueSoonPlanItems: { total: 2, items: [] }, upcomingDays: 7 }),
    )

    expect(lines[0]).toBe('2 plan items due in the next 7 days.')
  })
})
