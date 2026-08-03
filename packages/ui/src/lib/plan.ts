import { OPEN_PLAN_ITEM_STATUSES } from '@kelpie/schemas'
import type { PlanItem, PlanItemStatus } from '@kelpie/schemas'

import type { ChipTone } from '../components/Chip.tsx'

/**
 * How a page reads a set of plan items: which one is next, how urgent it is, and
 * what colour that makes it.
 *
 * Pure functions over `YYYY-MM-DD` strings, ported from the mockup's `seed.ts`.
 * Dates compare as text because the format sorts lexicographically, which avoids
 * parsing a calendar date into a `Date` and back out of whatever timezone the
 * browser is in.
 *
 * `today` is a parameter everywhere rather than a call to `new Date()` inside,
 * because a function that reads the clock cannot be tested against a fixed
 * expectation.
 */

/** The four groups the Deals list can be arranged into. */
export type DueBucketId = 'overdue' | 'this_week' | 'later' | 'no_plan'

export const DUE_BUCKETS: readonly { readonly id: DueBucketId; readonly label: string }[] = [
  { id: 'overdue', label: 'Overdue' },
  { id: 'this_week', label: 'This week' },
  { id: 'later', label: 'Later' },
  { id: 'no_plan', label: 'No plan' },
]

/**
 * A `Date` as the calendar day it is locally.
 *
 * Not `toISOString().slice(0, 10)`: that renders the UTC day, which is yesterday
 * or tomorrow for most of the world for part of every day.
 */
export function toIsoDay(value: Date): string {
  const year = value.getFullYear()
  const month = String(value.getMonth() + 1).padStart(2, '0')
  const day = String(value.getDate()).padStart(2, '0')

  return `${year}-${month}-${day}`
}

/** The day the reader is having. */
export function todayIso(now: Date = new Date()): string {
  return toIsoDay(now)
}

/** @returns `iso` moved by `days`, still `YYYY-MM-DD`. Parsed at midday so no timezone shifts the day. */
export function addDays(iso: string, days: number): string {
  const moved = new Date(`${iso}T12:00:00`)

  moved.setDate(moved.getDate() + days)

  return toIsoDay(moved)
}

/**
 * Which group a date falls into.
 *
 * @param planDate The date of the next open step, or undefined when there is none.
 *   "No plan" is a bucket rather than an omission: a record nobody has decided a
 *   next step for is the one most worth seeing.
 */
export function dueBucketFor(planDate: string | undefined, today: string = todayIso()): DueBucketId {
  if (planDate === undefined) {
    return 'no_plan'
  }

  if (planDate < today) {
    return 'overdue'
  }

  return planDate <= addDays(today, 7) ? 'this_week' : 'later'
}

/** Whether a plan item still needs doing. */
export function isOpen(item: PlanItem): boolean {
  return (OPEN_PLAN_ITEM_STATUSES as readonly PlanItemStatus[]).includes(item.status)
}

/** Soonest first, ties broken on title so a list does not reshuffle between renders. */
export function byDateThenTitle(left: PlanItem, right: PlanItem): number {
  return left.date.localeCompare(right.date) || left.title.localeCompare(right.title)
}

/**
 * The next step still to be done on one record.
 *
 * @returns undefined when every step is finished, which is a different state
 *   from having none at all, and both land in the `no_plan` bucket. A record
 *   whose plan is complete needs a new one either way.
 */
export function nextOpenPlanItem(
  items: readonly PlanItem[],
  targetId: string,
): PlanItem | undefined {
  return items
    .filter((item) => item.targetId === targetId && isOpen(item))
    .sort(byDateThenTitle)[0]
}

/** Open items grouped by record id, for a list page resolving one column. */
export function nextOpenByTarget(items: readonly PlanItem[]): ReadonlyMap<string, PlanItem> {
  const next = new Map<string, PlanItem>()

  for (const item of [...items].sort(byDateThenTitle)) {
    if (isOpen(item) && !next.has(item.targetId)) {
      next.set(item.targetId, item)
    }
  }

  return next
}

export interface PlanAttention {
  readonly overdue: readonly PlanItem[]
  readonly upcoming: readonly PlanItem[]
}

/** Open items that are late or due inside the week: what a record's Overview leads with. */
export function planAttention(
  items: readonly PlanItem[],
  today: string = todayIso(),
): PlanAttention {
  const open = items.filter(isOpen).sort(byDateThenTitle)

  return {
    overdue: open.filter((item) => dueBucketFor(item.date, today) === 'overdue'),
    upcoming: open.filter((item) => dueBucketFor(item.date, today) === 'this_week'),
  }
}

const STATUS_TONES: Readonly<Record<PlanItemStatus, ChipTone>> = {
  todo: 'warning',
  in_progress: 'accent',
  done: 'success',
}

export function planStatusTone(status: PlanItemStatus): ChipTone {
  return STATUS_TONES[status]
}

/** The inclusive `?from=`/`?to=` pair covering one month. `month` is 0-based, as `Date` counts. */
export function monthBounds(year: number, month: number): { from: string; to: string } {
  return { from: toIsoDay(new Date(year, month, 1)), to: toIsoDay(new Date(year, month + 1, 0)) }
}
