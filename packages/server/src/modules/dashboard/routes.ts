import type { Context, Hono } from 'hono'

import { readPageSize } from '../../lib/pagination.ts'
import type { Actor } from '../auth/actor.ts'
import { resolveActorFrom } from '../auth/credentials.ts'
import type { CredentialDependencies } from '../auth/credentials.ts'
import type {
  ActivitySignal,
  DashboardService,
  DashboardSnapshot,
  DecisionSignal,
  NoteSignal,
  PipelineSnapshot,
  PlanItemSignal,
  SignalList,
  StaleContactSignal,
  TouchpointSignal,
} from './service.ts'

/**
 * Wire shape for `GET /v1/dashboard`.
 *
 * One resource, no id and no collection, so there is no `{ data, next_cursor }`
 * envelope: `api.md` gives that to lists, and this is a single object made of
 * several of them.
 *
 * `?limit=` caps every embedded list at once. It is the only parameter, because
 * the thresholds are the definition of the signal rather than a caller's choice:
 * a "stale contact" the caller set the threshold for would mean something
 * different in every request, and the response echoes the ones it used.
 */

export interface DashboardRoutesDependencies extends CredentialDependencies {
  readonly service: DashboardService
}

/**
 * `?limit=`, validated against the same range every paged list uses.
 *
 * Absent stays absent rather than becoming the list default: the service owns
 * this one's default, because the MCP tool takes the same parameter and the two
 * must not disagree about what omitting it means.
 */
function readLimit(context: Context): number | undefined {
  const raw = context.req.query('limit')

  return raw === undefined ? undefined : readPageSize(raw)
}

function signalListBody<Item>(
  list: SignalList<Item>,
  render: (item: Item) => Record<string, unknown>,
): Record<string, unknown> {
  return { total: list.total, items: list.items.map(render) }
}

function pipelineBody(pipeline: PipelineSnapshot): Record<string, unknown> {
  return { kind: pipeline.kind, open: pipeline.open }
}

function planItemBody(item: PlanItemSignal): Record<string, unknown> {
  return {
    id: item.id,
    target_type: item.targetType,
    target_id: item.targetId,
    target_name: item.targetName,
    date: item.date,
    title: item.title,
    owner_id: item.ownerId,
    status: item.status,
  }
}

function touchpointBody(touchpoint: TouchpointSignal): Record<string, unknown> {
  return {
    id: touchpoint.id,
    name: touchpoint.name,
    company_id: touchpoint.companyId,
    next_touchpoint: touchpoint.nextTouchpoint,
    overdue: touchpoint.overdue,
    owner_id: touchpoint.ownerId,
    summary: touchpoint.summary,
  }
}

function staleContactBody(contact: StaleContactSignal): Record<string, unknown> {
  return {
    id: contact.id,
    name: contact.name,
    email: contact.email,
    last_contacted_at: contact.lastContactedAt.toISOString(),
    days_since_contact: contact.daysSinceContact,
    summary: contact.summary,
  }
}

function activityBody(activity: ActivitySignal): Record<string, unknown> {
  return {
    id: activity.id,
    target_type: activity.targetType,
    target_id: activity.targetId,
    target_name: activity.targetName,
    kind: activity.kind,
    actor_member_id: activity.actorMemberId,
    actor_label: activity.actorLabel,
    action: activity.action,
    detail: activity.detail,
    created_at: activity.createdAt.toISOString(),
  }
}

function noteBody(note: NoteSignal): Record<string, unknown> {
  return {
    id: note.id,
    target_type: note.targetType,
    target_id: note.targetId,
    target_name: note.targetName,
    body: note.body,
    author_id: note.authorId,
    pinned: note.pinned,
    created_at: note.createdAt.toISOString(),
  }
}

function decisionBody(decision: DecisionSignal): Record<string, unknown> {
  return {
    id: decision.id,
    target_type: decision.targetType,
    target_id: decision.targetId,
    target_name: decision.targetName,
    body: decision.body,
    rationale: decision.rationale,
    decided_at: decision.decidedAt.toISOString(),
    owner_id: decision.ownerId,
    due_at: decision.dueAt === null ? null : decision.dueAt.toISOString(),
  }
}

export function dashboardResponse(snapshot: DashboardSnapshot): Record<string, unknown> {
  return {
    generated_at: snapshot.generatedAt.toISOString(),
    today: snapshot.today,
    timezone: snapshot.timezone,
    stale_contact_days: snapshot.staleContactDays,
    upcoming_days: snapshot.upcomingDays,
    pipelines: snapshot.pipelines.map(pipelineBody),
    overdue_plan_items: signalListBody(snapshot.overduePlanItems, planItemBody),
    due_soon_plan_items: signalListBody(snapshot.dueSoonPlanItems, planItemBody),
    partnership_touchpoints: signalListBody(snapshot.partnershipTouchpoints, touchpointBody),
    stale_contacts: signalListBody(snapshot.staleContacts, staleContactBody),
    recent_activity: snapshot.recentActivity.map(activityBody),
    recent_notes: snapshot.recentNotes.map(noteBody),
    recent_decisions: snapshot.recentDecisions.map(decisionBody),
  }
}

export function mountDashboardRoutes(
  router: Hono,
  dependencies: DashboardRoutesDependencies,
): void {
  const requireActor = (context: Context): Promise<Actor> => resolveActorFrom(dependencies, context)

  router.get('/dashboard', async (context) => {
    const snapshot = await dependencies.service.snapshot(
      await requireActor(context),
      readLimit(context),
    )

    return context.json(dashboardResponse(snapshot))
  })
}
