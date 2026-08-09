import { z } from 'zod'

import {
  ACTIVITY_KINDS,
  PIPELINE_KINDS,
  PLAN_ITEM_STATUSES,
  RECORD_TARGET_TYPES,
} from './values.ts'
import type { ActivityKind, PipelineKind, PlanItemStatus, RecordTargetType } from './values.ts'
import { idSchema, nullableTimestampSchema, timestampSchema } from './wire.ts'

/**
 * Wire shape for `GET /v1/dashboard`. Read-only, so there is no body builder.
 *
 * One object rather than a list envelope: the workspace home is several
 * questions answered together, and two of them — a contact going cold, a
 * partnership touchpoint at hand — are not questions any resource list asks.
 *
 * Every attention signal is `{ total, items }`. `total` counts every matching
 * row; `items` holds however many the request's `?limit=` allowed. A page
 * showing four rows still reports the true count beside them.
 *
 * Rows that point at another record carry `targetName` already resolved. The
 * dashboard is the one place where every row points somewhere different, so
 * naming them client-side would mean a request per row.
 */

/** A row naming a record it is not itself. `targetName` is null when the target no longer resolves. */
export interface TargetRef {
  readonly targetType: RecordTargetType
  readonly targetId: string
  readonly targetName: string | null
}

const targetRef = {
  target_type: z.enum(RECORD_TARGET_TYPES),
  target_id: idSchema,
  target_name: z.string().nullable(),
}

function toTargetRef(wire: {
  target_type: RecordTargetType
  target_id: string
  target_name: string | null
}): TargetRef {
  return {
    targetType: wire.target_type,
    targetId: wire.target_id,
    targetName: wire.target_name,
  }
}

export interface DashboardSignal<Item> {
  readonly total: number
  readonly items: readonly Item[]
}

/** `{ total, items }` over one item schema. Generic so each signal declares only its row. */
function signalSchema<Item>(item: z.ZodType<Item, unknown>): z.ZodType<DashboardSignal<Item>, unknown> {
  return z.object({ total: z.number().int(), items: z.array(item) })
}

export interface DashboardPipeline {
  readonly kind: PipelineKind
  /** Records sitting in a stage the workspace has marked open. */
  readonly open: number
}

const dashboardPipelineSchema: z.ZodType<DashboardPipeline, unknown> = z.object({
  kind: z.enum(PIPELINE_KINDS),
  open: z.number().int(),
})

/**
 * An open plan item that is late or due inside the week.
 *
 * `targetType` is narrower than a `TargetRef`'s in practice — a plan item only
 * attaches to the four pipelines — but it is decoded against the wider set so
 * one target shape serves every signal here.
 */
export interface DashboardPlanItem extends TargetRef {
  readonly id: string
  /** `YYYY-MM-DD`, per `api.md` date-only fields. */
  readonly date: string
  readonly title: string
  readonly ownerId: string | null
  readonly status: PlanItemStatus
}

const dashboardPlanItemSchema: z.ZodType<DashboardPlanItem, unknown> = z
  .object({
    ...targetRef,
    id: idSchema,
    date: z.string(),
    title: z.string(),
    owner_id: idSchema.nullable(),
    status: z.enum(PLAN_ITEM_STATUSES),
  })
  .transform((wire) => ({
    ...toTargetRef(wire),
    id: wire.id,
    date: wire.date,
    title: wire.title,
    ownerId: wire.owner_id,
    status: wire.status,
  }))

export interface DashboardTouchpoint {
  readonly id: string
  readonly name: string
  readonly companyId: string
  /** `YYYY-MM-DD`. */
  readonly nextTouchpoint: string
  /** Whether the date has already passed. Both are in the list, oldest first. */
  readonly overdue: boolean
  readonly ownerId: string | null
  readonly summary: string
}

const dashboardTouchpointSchema: z.ZodType<DashboardTouchpoint, unknown> = z
  .object({
    id: idSchema,
    name: z.string(),
    company_id: idSchema,
    next_touchpoint: z.string(),
    overdue: z.boolean(),
    owner_id: idSchema.nullable(),
    summary: z.string(),
  })
  .transform((wire) => ({
    id: wire.id,
    name: wire.name,
    companyId: wire.company_id,
    nextTouchpoint: wire.next_touchpoint,
    overdue: wire.overdue,
    ownerId: wire.owner_id,
    summary: wire.summary,
  }))

export interface DashboardStaleContact {
  readonly id: string
  readonly name: string
  readonly email: string | null
  readonly lastContactedAt: Date
  /** Whole days from the last contact to today, both read in the workspace's zone. */
  readonly daysSinceContact: number
  readonly summary: string
}

const dashboardStaleContactSchema: z.ZodType<DashboardStaleContact, unknown> = z
  .object({
    id: idSchema,
    name: z.string(),
    email: z.string().nullable(),
    last_contacted_at: timestampSchema,
    days_since_contact: z.number().int(),
    summary: z.string(),
  })
  .transform((wire) => ({
    id: wire.id,
    name: wire.name,
    email: wire.email,
    lastContactedAt: wire.last_contacted_at,
    daysSinceContact: wire.days_since_contact,
    summary: wire.summary,
  }))

export interface DashboardActivity extends TargetRef {
  readonly id: string
  readonly kind: ActivityKind
  readonly actorMemberId: string | null
  readonly actorLabel: string | null
  readonly action: string
  readonly detail: string | null
  readonly createdAt: Date
}

const dashboardActivitySchema: z.ZodType<DashboardActivity, unknown> = z
  .object({
    ...targetRef,
    id: idSchema,
    kind: z.enum(ACTIVITY_KINDS),
    actor_member_id: idSchema.nullable(),
    actor_label: z.string().nullable(),
    action: z.string(),
    detail: z.string().nullable(),
    created_at: timestampSchema,
  })
  .transform((wire) => ({
    ...toTargetRef(wire),
    id: wire.id,
    kind: wire.kind,
    actorMemberId: wire.actor_member_id,
    actorLabel: wire.actor_label,
    action: wire.action,
    detail: wire.detail,
    createdAt: wire.created_at,
  }))

export interface DashboardNote extends TargetRef {
  readonly id: string
  readonly body: string
  readonly authorId: string | null
  readonly pinned: boolean
  readonly createdAt: Date
}

const dashboardNoteSchema: z.ZodType<DashboardNote, unknown> = z
  .object({
    ...targetRef,
    id: idSchema,
    body: z.string(),
    author_id: idSchema.nullable(),
    pinned: z.boolean(),
    created_at: timestampSchema,
  })
  .transform((wire) => ({
    ...toTargetRef(wire),
    id: wire.id,
    body: wire.body,
    authorId: wire.author_id,
    pinned: wire.pinned,
    createdAt: wire.created_at,
  }))

export interface DashboardDecision extends TargetRef {
  readonly id: string
  readonly body: string
  readonly rationale: string | null
  readonly decidedAt: Date
  readonly ownerId: string | null
  readonly dueAt: Date | null
}

const dashboardDecisionSchema: z.ZodType<DashboardDecision, unknown> = z
  .object({
    ...targetRef,
    id: idSchema,
    body: z.string(),
    rationale: z.string().nullable(),
    decided_at: timestampSchema,
    owner_id: idSchema.nullable(),
    due_at: nullableTimestampSchema,
  })
  .transform((wire) => ({
    ...toTargetRef(wire),
    id: wire.id,
    body: wire.body,
    rationale: wire.rationale,
    decidedAt: wire.decided_at,
    ownerId: wire.owner_id,
    dueAt: wire.due_at,
  }))

export interface Dashboard {
  readonly generatedAt: Date
  /** The day every signal was measured against, `YYYY-MM-DD`. */
  readonly today: string
  /** The workspace's IANA zone, which is what fixed `today`. */
  readonly timezone: string
  /** How long since a contact before it counts as going cold. */
  readonly staleContactDays: number
  /** How far ahead "due soon" looks. */
  readonly upcomingDays: number
  readonly pipelines: readonly DashboardPipeline[]
  readonly overduePlanItems: DashboardSignal<DashboardPlanItem>
  readonly dueSoonPlanItems: DashboardSignal<DashboardPlanItem>
  readonly partnershipTouchpoints: DashboardSignal<DashboardTouchpoint>
  readonly staleContacts: DashboardSignal<DashboardStaleContact>
  readonly recentActivity: readonly DashboardActivity[]
  readonly recentNotes: readonly DashboardNote[]
  readonly recentDecisions: readonly DashboardDecision[]
}

export const dashboardSchema: z.ZodType<Dashboard, unknown> = z
  .object({
    generated_at: timestampSchema,
    today: z.string(),
    timezone: z.string(),
    stale_contact_days: z.number().int(),
    upcoming_days: z.number().int(),
    pipelines: z.array(dashboardPipelineSchema),
    overdue_plan_items: signalSchema(dashboardPlanItemSchema),
    due_soon_plan_items: signalSchema(dashboardPlanItemSchema),
    partnership_touchpoints: signalSchema(dashboardTouchpointSchema),
    stale_contacts: signalSchema(dashboardStaleContactSchema),
    recent_activity: z.array(dashboardActivitySchema),
    recent_notes: z.array(dashboardNoteSchema),
    recent_decisions: z.array(dashboardDecisionSchema),
  })
  .transform(
    (wire): Dashboard => ({
      generatedAt: wire.generated_at,
      today: wire.today,
      timezone: wire.timezone,
      staleContactDays: wire.stale_contact_days,
      upcomingDays: wire.upcoming_days,
      pipelines: wire.pipelines,
      overduePlanItems: wire.overdue_plan_items,
      dueSoonPlanItems: wire.due_soon_plan_items,
      partnershipTouchpoints: wire.partnership_touchpoints,
      staleContacts: wire.stale_contacts,
      recentActivity: wire.recent_activity,
      recentNotes: wire.recent_notes,
      recentDecisions: wire.recent_decisions,
    }),
  )
