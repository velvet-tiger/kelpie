import type {
  Dashboard,
  DashboardPlanItem,
  DashboardStaleContact,
  DashboardTouchpoint,
  DashboardUpcomingEvent,
  RecordTargetType,
} from '@kelpie/schemas'

import type { ChipTone } from '../../components/Chip.tsx'
import { formatDate, formatDay } from '../../lib/dates.ts'

/**
 * Reading the workspace snapshot as a page: one attention list from the
 * signals the service already ranked.
 *
 * Pure functions over the decoded response, so the page renders and these are
 * tested separately. Nothing here recomputes a signal: the service already
 * decided what is overdue, against the workspace's own day, and a browser that
 * re-derived it from its own clock would disagree with the totals beside it.
 */

/** Where each kind of record lives. A Candidate has no page of its own: it is reached through its Role. */
const ROUTES: Readonly<Record<RecordTargetType, string | undefined>> = {
  person: '/people',
  company: '/companies',
  deal: '/deals',
  opportunity: '/opportunities',
  partnership: '/partnerships',
  raise: '/fundraising',
  enquiry: '/enquiries',
  candidate: undefined,
  event: '/events',
  attendance: undefined,
}

const TARGET_TYPE_LABELS: Readonly<Record<RecordTargetType, string>> = {
  person: 'Person',
  company: 'Company',
  deal: 'Deal',
  opportunity: 'Opportunity',
  partnership: 'Partnership',
  raise: 'Fundraising',
  enquiry: 'Enquiry',
  candidate: 'Candidate',
  event: 'Event',
  attendance: 'Attendance',
}

export function targetTypeLabel(targetType: RecordTargetType): string {
  return TARGET_TYPE_LABELS[targetType]
}

/**
 * @returns The record's page, or undefined when it has none. A row without a
 *   link renders as plain text rather than as a link to nowhere.
 */
export function targetHref(targetType: RecordTargetType, targetId: string): string | undefined {
  const route = ROUTES[targetType]

  return route === undefined ? undefined : `${route}/${targetId}`
}

/** How a target reads when it is named on another record's row. */
export function targetDescription(item: {
  readonly targetType: RecordTargetType
  readonly targetName: string | null
}): string {
  const label = targetTypeLabel(item.targetType)

  return item.targetName === null ? label : `${label} · ${item.targetName}`
}

export interface AttentionRow {
  readonly id: string
  /** What kind of signal this is, shown as a chip. */
  readonly label: string
  readonly tone: ChipTone
  /** The date or interval that makes it urgent. */
  readonly meta: string
  readonly title: string
  readonly detail: string
  readonly href: string | undefined
}

function planItemRow(item: DashboardPlanItem, overdue: boolean): AttentionRow {
  return {
    id: `plan-${item.id}`,
    label: overdue ? 'Plan item overdue' : 'Plan item due soon',
    tone: overdue ? 'danger' : 'warning',
    meta: formatDay(item.date),
    title: item.title,
    detail: targetDescription(item),
    href: targetHref(item.targetType, item.targetId),
  }
}

function touchpointRow(touchpoint: DashboardTouchpoint): AttentionRow {
  return {
    id: `touchpoint-${touchpoint.id}`,
    label: touchpoint.overdue ? 'Touchpoint overdue' : 'Touchpoint soon',
    tone: touchpoint.overdue ? 'danger' : 'warning',
    meta: `Touchpoint ${formatDay(touchpoint.nextTouchpoint)}`,
    title: touchpoint.name,
    detail: touchpoint.summary,
    href: `/partnerships/${touchpoint.id}`,
  }
}

function staleContactRow(contact: DashboardStaleContact): AttentionRow {
  return {
    id: `stale-${contact.id}`,
    label: 'Stale contact',
    tone: 'neutral',
    meta: `${String(contact.daysSinceContact)} days since contact`,
    title: contact.name,
    detail: contact.summary,
    href: `/people/${contact.id}`,
  }
}

function upcomingEventRow(event: DashboardUpcomingEvent, timezone: string): AttentionRow {
  const where = event.location.length > 0 ? event.location : event.format

  return {
    id: `event-${event.id}`,
    label: 'Upcoming event',
    tone: 'accent',
    meta: formatDate(event.startsAt, timezone),
    title: event.name,
    detail: `${String(event.attendeeCount)} registered · ${where}`,
    href: `/events/${event.id}`,
  }
}

/**
 * The attention list, most urgent first.
 *
 * The groups are concatenated rather than sorted: each arrives from the API in
 * its own order — plan items soonest first, contacts coldest first — and a
 * re-sort across the three would throw that away for a single column that means
 * a different thing in each.
 */
export function attentionRows(dashboard: Dashboard): readonly AttentionRow[] {
  const touchpoints = dashboard.partnershipTouchpoints.items

  return [
    ...dashboard.overduePlanItems.items.map((item) => planItemRow(item, true)),
    ...touchpoints.filter((touchpoint) => touchpoint.overdue).map(touchpointRow),
    ...dashboard.dueSoonPlanItems.items.map((item) => planItemRow(item, false)),
    ...touchpoints.filter((touchpoint) => !touchpoint.overdue).map(touchpointRow),
    ...dashboard.upcomingEvents.items.map((item) => upcomingEventRow(item, dashboard.timezone)),
    ...dashboard.staleContacts.items.map(staleContactRow),
  ]
}
