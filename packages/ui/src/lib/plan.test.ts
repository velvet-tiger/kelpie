import type { PlanItem, PlanItemStatus } from '@kelpie/schemas'
import { describe, expect, it } from 'vitest'

import {
  addDays,
  dueBucketFor,
  monthBounds,
  nextOpenByTarget,
  nextOpenPlanItem,
  planAttention,
  toIsoDay,
} from './plan.ts'

/**
 * The arithmetic behind "overdue" and "what is next".
 *
 * These decide what a Deals board shouts about, so they get a test rather than a
 * careful read. `today` is passed in everywhere: pinning it is the whole reason
 * these functions take it.
 */

const TODAY = '2026-08-03'

function planItem(date: string, overrides: Partial<PlanItem> = {}): PlanItem {
  return {
    id: `plan_${date}${overrides.title ?? ''}`,
    targetType: 'deal',
    targetId: 'deal_1',
    date,
    title: 'Send proposal',
    ownerId: null,
    status: 'todo' as PlanItemStatus,
    createdAt: new Date('2026-08-01T00:00:00.000Z'),
    updatedAt: new Date('2026-08-01T00:00:00.000Z'),
    ...overrides,
  }
}

describe('toIsoDay', () => {
  it('renders the local calendar day, not the UTC one', () => {
    // 23:30 local on the 3rd is the 4th in UTC anywhere east of Greenwich, and
    // the reader is still having the 3rd.
    expect(toIsoDay(new Date(2026, 7, 3, 23, 30))).toBe('2026-08-03')
  })
})

describe('addDays', () => {
  it('crosses a month boundary', () => {
    expect(addDays('2026-08-30', 7)).toBe('2026-09-06')
  })

  it('crosses a leap day', () => {
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29')
  })
})

describe('dueBucketFor', () => {
  it('calls yesterday overdue', () => {
    expect(dueBucketFor('2026-08-02', TODAY)).toBe('overdue')
  })

  it('calls today this week', () => {
    expect(dueBucketFor(TODAY, TODAY)).toBe('this_week')
  })

  it('includes the seventh day ahead and excludes the eighth', () => {
    expect(dueBucketFor('2026-08-10', TODAY)).toBe('this_week')
    expect(dueBucketFor('2026-08-11', TODAY)).toBe('later')
  })

  it('puts a record with no next step in its own bucket', () => {
    expect(dueBucketFor(undefined, TODAY)).toBe('no_plan')
  })
})

describe('nextOpenPlanItem', () => {
  it('takes the soonest step that is not finished', () => {
    const items = [
      planItem('2026-08-20', { title: 'Later' }),
      planItem('2026-08-05', { title: 'Done already', status: 'done' }),
      planItem('2026-08-10', { title: 'Next' }),
    ]

    expect(nextOpenPlanItem(items, 'deal_1')?.title).toBe('Next')
  })

  it('breaks a date tie on the title, so the answer does not move between renders', () => {
    const items = [
      planItem('2026-08-10', { title: 'Zebra' }),
      planItem('2026-08-10', { title: 'Aardvark' }),
    ]

    expect(nextOpenPlanItem(items, 'deal_1')?.title).toBe('Aardvark')
  })

  it('ignores another record’s steps', () => {
    const items = [planItem('2026-08-05', { targetId: 'deal_2', title: 'Theirs' })]

    expect(nextOpenPlanItem(items, 'deal_1')).toBeUndefined()
  })

  it('answers undefined when every step is finished', () => {
    expect(nextOpenPlanItem([planItem('2026-08-05', { status: 'done' })], 'deal_1')).toBeUndefined()
  })
})

describe('nextOpenByTarget', () => {
  it('gives each record its own soonest open step', () => {
    const items = [
      planItem('2026-08-20', { targetId: 'deal_1', title: 'Late one' }),
      planItem('2026-08-04', { targetId: 'deal_1', title: 'Early one' }),
      planItem('2026-08-09', { targetId: 'deal_2', title: 'Only one' }),
      planItem('2026-08-01', { targetId: 'deal_2', title: 'Finished', status: 'done' }),
    ]
    const next = nextOpenByTarget(items)

    expect(next.get('deal_1')?.title).toBe('Early one')
    expect(next.get('deal_2')?.title).toBe('Only one')
  })
})

describe('planAttention', () => {
  it('splits late work from work due inside the week and drops the rest', () => {
    const items = [
      planItem('2026-07-30', { title: 'Late' }),
      planItem('2026-08-06', { title: 'Soon' }),
      planItem('2026-09-01', { title: 'Distant' }),
      planItem('2026-07-01', { title: 'Late but finished', status: 'done' }),
    ]
    const { overdue, upcoming } = planAttention(items, TODAY)

    expect(overdue.map((item) => item.title)).toEqual(['Late'])
    expect(upcoming.map((item) => item.title)).toEqual(['Soon'])
  })
})

describe('monthBounds', () => {
  it('covers a whole month, last day included', () => {
    expect(monthBounds(2026, 7)).toEqual({ from: '2026-08-01', to: '2026-08-31' })
  })

  it('knows how long February is', () => {
    expect(monthBounds(2028, 1)).toEqual({ from: '2028-02-01', to: '2028-02-29' })
  })
})
