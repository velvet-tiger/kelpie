import { PIPELINE_KIND_LABELS, PLAN_ITEM_STATUS_LABELS } from '@kelpie/schemas'
import type { Deal, Opportunity, Partnership, PipelineKind, PlanItem } from '@kelpie/schemas'
import { Link } from 'react-router'

import { useMembers } from '../api/resources/members.ts'
import { usePlanItemsForRecords } from '../api/resources/planItems.ts'
import { formatDay } from '../lib/dates.ts'
import { planAttention, planStatusTone } from '../lib/plan.ts'
import { Chip } from './Chip.tsx'
import { SectionHeader } from './SectionHeader.tsx'

/**
 * The plan an Overview leads with: what is late, and what is due inside the week.
 *
 * Takes the items rather than fetching them, because the three pages that show
 * this ask three different questions. A pipeline record's Overview asks for its
 * own steps; a Person or Company asks for the steps of every record they are
 * attached to, which is two requests the page already has to make.
 */

/** Where a plan item's record lives. Raises have no page yet. */
const ROUTES: Readonly<Record<PipelineKind, string | undefined>> = {
  deal: '/deals',
  opportunity: '/opportunities',
  raise: undefined,
  partnership: '/partnerships',
}

export interface PlanAttentionProps {
  readonly items: readonly PlanItem[]
  /** Names the record each item belongs to. Off on a record's own page, where it is the same one every row. */
  readonly showTarget?: boolean
  /** How to write a target id. Absent ids render as the type alone rather than as an id. */
  readonly targetNames?: ReadonlyMap<string, string>
  readonly isLoading?: boolean
}

export function PlanAttention({
  items,
  showTarget = false,
  targetNames,
  isLoading = false,
}: PlanAttentionProps): React.JSX.Element {
  const { overdue, upcoming } = planAttention(items)
  const empty = overdue.length === 0 && upcoming.length === 0

  return (
    <section>
      <SectionHeader title="Plan" description="Overdue and due this week" />
      {isLoading ? (
        <p className="text-[13px] text-ink-faint">Loading plan…</p>
      ) : empty ? (
        <p className="text-[13px] text-ink-faint">No overdue or upcoming plan items.</p>
      ) : (
        <div className="space-y-4">
          {overdue.length > 0 && (
            <PlanGroup
              label="Overdue"
              tone="danger"
              items={overdue}
              showTarget={showTarget}
              targetNames={targetNames}
            />
          )}
          {upcoming.length > 0 && (
            <PlanGroup
              label="Upcoming"
              tone="warning"
              items={upcoming}
              showTarget={showTarget}
              targetNames={targetNames}
            />
          )}
        </div>
      )}
    </section>
  )
}

/**
 * The plan rolled up from a Person's or a Company's pipeline records.
 *
 * Deals, opportunities and partnerships, and that is the whole roll-up today
 * rather than a slice of it: raises have no create route, so nothing in the
 * workspace can have a plan item attached to one. This widens when they land.
 * A person's list passes no opportunities, because an opportunity has no people.
 *
 * @param deals The records to roll up, which the page has already fetched to
 *   render its own related list.
 */
export function RelatedPlanAttention({
  deals,
  opportunities = [],
  partnerships = [],
  isLoading,
}: {
  readonly deals: readonly Deal[]
  readonly opportunities?: readonly Opportunity[]
  readonly partnerships?: readonly Partnership[]
  readonly isLoading: boolean
}): React.JSX.Element {
  const dealItems = usePlanItemsForRecords(
    'deal',
    deals.map((deal) => deal.id),
  )
  const opportunityItems = usePlanItemsForRecords(
    'opportunity',
    opportunities.map((opportunity) => opportunity.id),
  )
  const partnershipItems = usePlanItemsForRecords(
    'partnership',
    partnerships.map((partnership) => partnership.id),
  )

  return (
    <PlanAttention
      items={[...dealItems.records, ...opportunityItems.records, ...partnershipItems.records]}
      showTarget
      targetNames={
        new Map(
          [...deals, ...opportunities, ...partnerships].map((record) => [record.id, record.name]),
        )
      }
      isLoading={
        isLoading || dealItems.isLoading || opportunityItems.isLoading || partnershipItems.isLoading
      }
    />
  )
}

function PlanGroup({
  label,
  tone,
  items,
  showTarget,
  targetNames,
}: {
  readonly label: string
  readonly tone: 'danger' | 'warning'
  readonly items: readonly PlanItem[]
  readonly showTarget: boolean
  readonly targetNames: ReadonlyMap<string, string> | undefined
}): React.JSX.Element {
  return (
    <div>
      <div className="mb-2 flex items-center gap-2">
        <h3 className="text-[12px] font-semibold text-ink">{label}</h3>
        <Chip tone={tone}>{items.length}</Chip>
      </div>
      <ul className="overflow-hidden rounded-md border border-border">
        {items.map((item) => (
          <PlanAttentionRow
            key={item.id}
            item={item}
            dateTone={tone}
            showTarget={showTarget}
            targetNames={targetNames}
          />
        ))}
      </ul>
    </div>
  )
}

function PlanAttentionRow({
  item,
  dateTone,
  showTarget,
  targetNames,
}: {
  readonly item: PlanItem
  readonly dateTone: 'danger' | 'warning'
  readonly showTarget: boolean
  readonly targetNames: ReadonlyMap<string, string> | undefined
}): React.JSX.Element {
  const members = useMembers()

  return (
    <li className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-border px-4 py-2.5 last:border-0">
      <time
        dateTime={item.date}
        className={[
          'shrink-0 text-[12px] font-medium tabular-nums',
          dateTone === 'danger' ? 'text-danger' : 'text-warning',
        ].join(' ')}
      >
        {formatDay(item.date)}
      </time>
      <span className="min-w-0 flex-1 text-[13px] text-ink">{item.title}</span>
      {showTarget && <PlanTargetLink item={item} targetNames={targetNames} />}
      {item.ownerId !== null && (
        <span className="text-[12px] text-ink-muted">
          {members.nameById.get(item.ownerId) ?? 'Unknown'}
        </span>
      )}
      <Chip tone={planStatusTone(item.status)}>{PLAN_ITEM_STATUS_LABELS[item.status]}</Chip>
    </li>
  )
}

/**
 * The record a step belongs to.
 *
 * A pipeline with no page yet renders as its type alone. Naming the type and
 * stopping is honest; printing a raw id, or linking to a route that does not
 * exist, is not.
 */
export function PlanTargetLink({
  item,
  targetNames,
}: {
  readonly item: PlanItem
  readonly targetNames: ReadonlyMap<string, string> | undefined
}): React.JSX.Element {
  const kind = PIPELINE_KIND_LABELS[item.targetType]
  const name = targetNames?.get(item.targetId)
  const route = ROUTES[item.targetType]

  if (route === undefined || name === undefined) {
    return <span className="truncate text-[11px] text-ink-faint">{kind}</span>
  }

  return (
    <Link
      to={`${route}/${item.targetId}`}
      className="truncate text-[11px] text-ink-faint hover:text-accent"
    >
      {kind} · {name}
    </Link>
  )
}
