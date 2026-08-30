import type {
  Dashboard,
  DashboardPlanItem,
  DashboardStaleContact,
  DashboardTouchpoint,
  PipelineKind,
  RecordTargetType,
} from '@kelpie/schemas'

import type { ChipTone } from '../../components/Chip.tsx'
import { formatDay } from '../../lib/dates.ts'

/**
 * Reading the workspace snapshot as a page: one attention list, and the brief
 * above it.
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

/**
 * The signals behind the brief, most urgent first.
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
    ...dashboard.staleContacts.items.map(staleContactRow),
  ]
}

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${String(count)} ${count === 1 ? singular : pluralForm}`
}

/**
 * How a count of open records reads mid-sentence.
 *
 * Not `PIPELINE_KIND_LABELS`: that one is nav wording, where a Raise is filed
 * under "Fundraising", and "3 fundraisings" is not a sentence. Written out
 * rather than suffixed, because "opportunitys" is not one either.
 */
const OPEN_PIPELINE_NOUNS: Readonly<
  Record<PipelineKind, { readonly one: string; readonly many: string }>
> = {
  enquiry: { one: 'enquiry', many: 'enquiries' },
  deal: { one: 'deal', many: 'deals' },
  opportunity: { one: 'opportunity', many: 'opportunities' },
  raise: { one: 'raise', many: 'raises' },
  partnership: { one: 'partnership', many: 'partnerships' },
}

/**
 * The brief, built from the totals rather than from the rows.
 *
 * A list is capped by the request's limit and a total is not, so counting the
 * rows on screen would understate every workspace with more than a page of them.
 */
export function briefLines(dashboard: Dashboard): readonly string[] {
  const lines: string[] = []

  if (dashboard.overduePlanItems.total > 0) {
    lines.push(
      `${plural(dashboard.overduePlanItems.total, 'plan item')} overdue — triage Planning first.`,
    )
  }

  if (dashboard.dueSoonPlanItems.total > 0) {
    lines.push(
      `${plural(dashboard.dueSoonPlanItems.total, 'plan item')} due in the next ${plural(dashboard.upcomingDays, 'day')}.`,
    )
  }

  if (dashboard.partnershipTouchpoints.total > 0) {
    lines.push(
      `${plural(dashboard.partnershipTouchpoints.total, 'partnership touchpoint')} at hand.`,
    )
  }

  if (dashboard.staleContacts.total > 0) {
    lines.push(
      `${plural(dashboard.staleContacts.total, 'contact')} past the ${String(dashboard.staleContactDays)}-day touch threshold.`,
    )
  }

  const open = dashboard.pipelines.filter((pipeline) => pipeline.open > 0)

  if (open.length > 0) {
    lines.push(
      `Open: ${open
        .map((pipeline) => {
          const noun = OPEN_PIPELINE_NOUNS[pipeline.kind]

          return plural(pipeline.open, noun.one, noun.many)
        })
        .join(', ')}.`,
    )
  }

  return lines.length === 0
    ? ['Nothing urgent. Pipeline and relationships look quiet today.']
    : lines
}
