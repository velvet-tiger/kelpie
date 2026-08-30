import { OPEN_PLAN_ITEM_STATUSES } from '@kelpie/schemas'
import type { AgentTaskDefinition, AgentTaskTargetType } from '@kelpie/schemas'
import { and, asc, count, eq, inArray, notExists, sql } from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core'

import type { Queryable } from '../../runtime/transaction.ts'
import { companies } from '../companies/schema.ts'
import { deals } from '../deals/schema.ts'
import { decisions } from '../decisions/schema.ts'
import { enquiries } from '../enquiries/schema.ts'
import { handbookPages } from '../handbook/schema.ts'
import { candidates, roles } from '../hiring/schema.ts'
import { notes } from '../notes/schema.ts'
import { opportunities } from '../opportunities/schema.ts'
import { partnerships } from '../partnerships/schema.ts'
import { people, personLinks } from '../people/schema.ts'
import { pipelineStages } from '../pipelines/schema.ts'
import { planItems } from '../plans/schema.ts'
import { positions } from '../positions/schema.ts'
import { raises } from '../raises/schema.ts'
import { isRecordTargetType, resolveTargetNames, targetKey } from '../recordTargets.ts'
import { workspaces } from '../workspace/schema.ts'
import type { HandbookPageReference, PromptInputs, RelatedIdList, WorkspaceSignal } from './prompt.ts'

/**
 * The reads behind `POST /v1/agent-tasks/:id/resolve` — everything the prompt
 * renderer needs, gathered from the modules that own each table.
 *
 * This file reads eleven other modules' tables and none of their repositories,
 * the crossing `architecture.md` rule 3 permits and the dashboard set the
 * precedent for. The module's `requires` names every one, so an assembly that
 * omits one fails at boot rather than querying an unmigrated table.
 */

/**
 * How many ids one "Related ids" list may carry. The pack is a pointer, not a
 * dump: past this the prompt marks the list truncated and the agent pages the
 * list endpoint itself.
 */
export const RELATED_ID_LIMIT = 100

/** How many record ids one workspace signal names. Totals stay exact regardless. */
export const SIGNAL_ID_LIMIT = 25

/** UI paths for the six targets whose route is just the plural. From the ported app, not the mockup: a Raise lives under `/fundraising`. */
const DEEP_LINKS: Readonly<Partial<Record<AgentTaskTargetType, string>>> = {
  person: '/people',
  company: '/companies',
  deal: '/deals',
  enquiry: '/enquiries',
  opportunity: '/opportunities',
  partnership: '/partnerships',
  raise: '/fundraising',
}

export interface TargetMeta {
  readonly label: string
  readonly deepLink: string
}

/**
 * What to call the target and where the UI shows it.
 *
 * @returns undefined when the target does not exist in this workspace — the
 *   service turns that into the same 404 a missing record answers everywhere.
 */
export async function resolveTargetMeta(
  db: Queryable,
  workspaceId: string,
  targetType: AgentTaskTargetType,
  targetId: string,
): Promise<TargetMeta | undefined> {
  if (targetType === 'workspace') {
    // The only workspace a caller may name is their own; any other id is
    // indistinguishable from one that never existed.
    if (targetId !== workspaceId) {
      return undefined
    }

    const [workspace] = await db
      .select({ name: workspaces.name })
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId))

    return workspace === undefined ? undefined : { label: workspace.name, deepLink: '/dashboard' }
  }

  if (targetType === 'handbook') {
    const [page] = await db
      .select({ title: handbookPages.title })
      .from(handbookPages)
      .where(and(eq(handbookPages.workspaceId, workspaceId), eq(handbookPages.id, targetId)))

    return page === undefined
      ? undefined
      : { label: page.title, deepLink: `/handbook/${targetId}` }
  }

  if (targetType === 'role') {
    const [role] = await db
      .select({ title: roles.title })
      .from(roles)
      .where(and(eq(roles.workspaceId, workspaceId), eq(roles.id, targetId)))

    return role === undefined ? undefined : { label: role.title, deepLink: `/hiring/${targetId}` }
  }

  if (targetType === 'candidate') {
    // A candidate is named by both halves of the link: the person, then the
    // role they are in process for, the label the mockup renders.
    const [candidate] = await db
      .select({ person: people.name, roleId: candidates.roleId, roleTitle: roles.title })
      .from(candidates)
      .innerJoin(people, eq(candidates.personId, people.id))
      .innerJoin(roles, eq(candidates.roleId, roles.id))
      .where(and(eq(candidates.workspaceId, workspaceId), eq(candidates.id, targetId)))

    return candidate === undefined
      ? undefined
      : {
          label: `${candidate.person} · ${candidate.roleTitle}`,
          deepLink: `/hiring/${candidate.roleId}`,
        }
  }

  const names = await resolveTargetNames(db, workspaceId, [{ targetType, targetId }])
  const name = names.get(targetKey({ targetType, targetId }))
  const path = DEEP_LINKS[targetType]

  if (name === undefined || path === undefined) {
    return undefined
  }

  return { label: name, deepLink: `${path}/${targetId}` }
}

/** The workspace's copies of the pages a definition names, in the definition's order. */
async function findHandbookPages(
  db: Queryable,
  workspaceId: string,
  slugs: readonly string[],
): Promise<readonly HandbookPageReference[]> {
  if (slugs.length === 0) {
    return []
  }

  const rows = await db
    .select({ id: handbookPages.id, slug: handbookPages.slug, title: handbookPages.title })
    .from(handbookPages)
    .where(and(eq(handbookPages.workspaceId, workspaceId), inArray(handbookPages.slug, [...slugs])))

  const bySlug = new Map(rows.map((row) => [row.slug, row]))

  // A slug with no page in this workspace is dropped rather than rendered as a
  // dead reference: the starter set can be renamed or deleted per workspace.
  return slugs.flatMap((slug) => {
    const page = bySlug.get(slug)

    return page === undefined
      ? []
      : [{ slug: page.slug, title: page.title, deepLink: `/handbook/${page.id}` }]
  })
}

async function collectPinnedNoteIds(
  db: Queryable,
  workspaceId: string,
  targetType: string,
  targetId: string,
): Promise<readonly string[]> {
  const rows = await db
    .select({ id: notes.id })
    .from(notes)
    .where(
      and(
        eq(notes.workspaceId, workspaceId),
        eq(notes.targetType, targetType),
        eq(notes.targetId, targetId),
        eq(notes.pinned, true),
      ),
    )
    .orderBy(asc(notes.id))

  return rows.map((row) => row.id)
}

async function collectOpenDecisionIds(
  db: Queryable,
  workspaceId: string,
  targetType: string,
  targetId: string,
): Promise<readonly string[]> {
  const rows = await db
    .select({ id: decisions.id })
    .from(decisions)
    .where(
      and(
        eq(decisions.workspaceId, workspaceId),
        eq(decisions.targetType, targetType),
        eq(decisions.targetId, targetId),
      ),
    )
    .orderBy(asc(decisions.id))

  return rows.map((row) => row.id)
}

async function collectOpenPlanIds(
  db: Queryable,
  workspaceId: string,
  targetType: string,
  targetId: string,
): Promise<readonly string[]> {
  const rows = await db
    .select({ id: planItems.id })
    .from(planItems)
    .where(
      and(
        eq(planItems.workspaceId, workspaceId),
        eq(planItems.targetType, targetType),
        eq(planItems.targetId, targetId),
        inArray(planItems.status, [...OPEN_PLAN_ITEM_STATUSES]),
      ),
    )
    .orderBy(asc(planItems.date), asc(planItems.id))

  return rows.map((row) => row.id)
}

/** Caps a list fetched with `RELATED_ID_LIMIT + 1`, remembering that it overflowed. */
function limitedIds(ids: readonly string[]): RelatedIdList {
  return ids.length > RELATED_ID_LIMIT
    ? { ids: ids.slice(0, RELATED_ID_LIMIT), truncated: true }
    : { ids: [...ids], truncated: false }
}

function wholeList(ids: readonly string[]): RelatedIdList {
  return { ids: [...ids], truncated: false }
}

async function relatedFrom(
  db: Queryable,
  table: PgTable,
  idColumn: PgColumn,
  where: SQL,
): Promise<RelatedIdList> {
  const rows = await db
    .select({ id: sql<string>`${idColumn}` })
    .from(table)
    .where(where)
    .orderBy(asc(idColumn))
    .limit(RELATED_ID_LIMIT + 1)

  return limitedIds(rows.map((row) => row.id))
}

/**
 * The people on one pipeline record, capped and truncation-aware. Uses
 * `person_links` directly rather than the shared helper because it needs the
 * limit + 1 semantics of `relatedFrom`.
 */
async function personLinkIds(
  db: Queryable,
  workspaceId: string,
  targetType: 'deal' | 'enquiry' | 'opportunity' | 'partnership' | 'raise',
  targetId: string,
): Promise<RelatedIdList> {
  const rows = await db
    .select({ id: personLinks.personId })
    .from(personLinks)
    .where(
      and(
        eq(personLinks.workspaceId, workspaceId),
        eq(personLinks.targetType, targetType),
        eq(personLinks.targetId, targetId),
      ),
    )
    .orderBy(asc(personLinks.personId))
    .limit(RELATED_ID_LIMIT + 1)

  return limitedIds(rows.map((row) => row.id))
}

/**
 * The related record ids `agent-tasks.md`'s context recipe names, per target
 * type: positions for a person, people on a deal, the company behind a raise,
 * candidates on a role, and so on. Only relations the data model records — no
 * key is ever inferred.
 */
async function collectRelated(
  db: Queryable,
  workspaceId: string,
  targetType: AgentTaskTargetType,
  targetId: string,
): Promise<Readonly<Record<string, RelatedIdList>>> {
  switch (targetType) {
    case 'person': {
      const rows = await db
        .select({ id: positions.id, companyId: positions.companyId })
        .from(positions)
        .where(and(eq(positions.workspaceId, workspaceId), eq(positions.personId, targetId)))
        .orderBy(asc(positions.id))
        .limit(RELATED_ID_LIMIT + 1)

      return {
        position_ids: limitedIds(rows.map((row) => row.id)),
        company_ids: limitedIds([...new Set(rows.map((row) => row.companyId))]),
      }
    }

    case 'company': {
      const workspaceScoped = (workspaceColumn: PgColumn, companyColumn: PgColumn): SQL =>
        and(eq(workspaceColumn, workspaceId), eq(companyColumn, targetId)) as SQL

      return {
        person_ids: await relatedFrom(
          db,
          positions,
          positions.personId,
          workspaceScoped(positions.workspaceId, positions.companyId),
        ),
        deal_ids: await relatedFrom(
          db,
          deals,
          deals.id,
          workspaceScoped(deals.workspaceId, deals.companyId),
        ),
        enquiry_ids: await relatedFrom(
          db,
          enquiries,
          enquiries.id,
          workspaceScoped(enquiries.workspaceId, enquiries.companyId),
        ),
        opportunity_ids: await relatedFrom(
          db,
          opportunities,
          opportunities.id,
          workspaceScoped(opportunities.workspaceId, opportunities.companyId),
        ),
        partnership_ids: await relatedFrom(
          db,
          partnerships,
          partnerships.id,
          workspaceScoped(partnerships.workspaceId, partnerships.companyId),
        ),
        raise_ids: await relatedFrom(
          db,
          raises,
          raises.id,
          workspaceScoped(raises.workspaceId, raises.companyId),
        ),
      }
    }

    case 'deal': {
      const [deal] = await db
        .select({ companyId: deals.companyId })
        .from(deals)
        .where(and(eq(deals.workspaceId, workspaceId), eq(deals.id, targetId)))

      return {
        company_ids: wholeList(deal === undefined ? [] : [deal.companyId]),
        person_ids: await personLinkIds(db, workspaceId, 'deal', targetId),
      }
    }

    case 'opportunity': {
      const [opportunity] = await db
        .select({ companyId: opportunities.companyId })
        .from(opportunities)
        .where(and(eq(opportunities.workspaceId, workspaceId), eq(opportunities.id, targetId)))

      return {
        company_ids: wholeList(
          opportunity?.companyId === null || opportunity === undefined
            ? []
            : [opportunity.companyId],
        ),
        person_ids: await personLinkIds(db, workspaceId, 'opportunity', targetId),
      }
    }

    case 'enquiry': {
      const [enquiry] = await db
        .select({ companyId: enquiries.companyId })
        .from(enquiries)
        .where(and(eq(enquiries.workspaceId, workspaceId), eq(enquiries.id, targetId)))

      return {
        company_ids: wholeList(
          enquiry?.companyId === null || enquiry === undefined ? [] : [enquiry.companyId],
        ),
        person_ids: await personLinkIds(db, workspaceId, 'enquiry', targetId),
      }
    }

    case 'partnership': {
      const [partnership] = await db
        .select({ companyId: partnerships.companyId })
        .from(partnerships)
        .where(and(eq(partnerships.workspaceId, workspaceId), eq(partnerships.id, targetId)))

      return {
        company_ids: wholeList(partnership === undefined ? [] : [partnership.companyId]),
        person_ids: await personLinkIds(db, workspaceId, 'partnership', targetId),
      }
    }

    case 'raise': {
      const [raise] = await db
        .select({ companyId: raises.companyId })
        .from(raises)
        .where(and(eq(raises.workspaceId, workspaceId), eq(raises.id, targetId)))

      return {
        company_ids: wholeList(raise === undefined ? [] : [raise.companyId]),
        person_ids: await personLinkIds(db, workspaceId, 'raise', targetId),
      }
    }

    case 'candidate': {
      const [candidate] = await db
        .select({ personId: candidates.personId, roleId: candidates.roleId })
        .from(candidates)
        .where(and(eq(candidates.workspaceId, workspaceId), eq(candidates.id, targetId)))

      return candidate === undefined
        ? {}
        : {
            person_ids: wholeList([candidate.personId]),
            role_ids: wholeList([candidate.roleId]),
          }
    }

    case 'role':
      return {
        candidate_ids: await relatedFrom(
          db,
          candidates,
          candidates.id,
          and(eq(candidates.workspaceId, workspaceId), eq(candidates.roleId, targetId)) as SQL,
        ),
      }

    case 'handbook':
    case 'workspace':
      return {}
  }
}

/** A pipeline table, as the sweeps walk one: id, stage, and the summary column. */
interface SweepTable {
  readonly table: PgTable
  readonly id: PgColumn
  readonly workspaceId: PgColumn
  readonly stageId: PgColumn
  readonly summary: PgColumn
}

const SWEEP_TABLES = {
  deal: {
    table: deals,
    id: deals.id,
    workspaceId: deals.workspaceId,
    stageId: deals.stageId,
    summary: deals.summary,
  },
  enquiry: {
    table: enquiries,
    id: enquiries.id,
    workspaceId: enquiries.workspaceId,
    stageId: enquiries.stageId,
    summary: enquiries.summary,
  },
  opportunity: {
    table: opportunities,
    id: opportunities.id,
    workspaceId: opportunities.workspaceId,
    stageId: opportunities.stageId,
    summary: opportunities.summary,
  },
  partnership: {
    table: partnerships,
    id: partnerships.id,
    workspaceId: partnerships.workspaceId,
    stageId: partnerships.stageId,
    summary: partnerships.summary,
  },
  raise: {
    table: raises,
    id: raises.id,
    workspaceId: raises.workspaceId,
    stageId: raises.stageId,
    summary: raises.summary,
  },
} satisfies Readonly<Record<string, SweepTable>>

/** Exact total plus the first `SIGNAL_ID_LIMIT` ids for one signal's conditions. */
async function signalOver(
  db: Queryable,
  label: string,
  table: PgTable,
  idColumn: PgColumn,
  conditions: SQL,
  join?: { readonly table: PgTable; readonly on: SQL },
): Promise<WorkspaceSignal> {
  const totalRows =
    join === undefined
      ? await db.select({ total: count() }).from(table).where(conditions)
      : await db
          .select({ total: count() })
          .from(table)
          .innerJoin(join.table, join.on)
          .where(conditions)
  const idRows =
    join === undefined
      ? await db
          .select({ id: sql<string>`${idColumn}` })
          .from(table)
          .where(conditions)
          .orderBy(asc(idColumn))
          .limit(SIGNAL_ID_LIMIT)
      : await db
          .select({ id: sql<string>`${idColumn}` })
          .from(table)
          .innerJoin(join.table, join.on)
          .where(conditions)
          .orderBy(asc(idColumn))
          .limit(SIGNAL_ID_LIMIT)

  return { label, total: totalRows[0]?.total ?? 0, ids: idRows.map((row) => row.id) }
}

function openStageSignal(
  db: Queryable,
  workspaceId: string,
  label: string,
  sweep: SweepTable,
  extra: SQL,
): Promise<WorkspaceSignal> {
  return signalOver(
    db,
    label,
    sweep.table,
    sweep.id,
    and(eq(sweep.workspaceId, workspaceId), eq(pipelineStages.open, true), extra) as SQL,
    { table: pipelineStages, on: eq(sweep.stageId, pipelineStages.id) },
  )
}

/** True of a pipeline record with no open Plan item attached to it. */
function noOpenPlan(db: Queryable, workspaceId: string, kind: string, idColumn: PgColumn): SQL {
  return notExists(
    db
      .select({ one: sql`1` })
      .from(planItems)
      .where(
        and(
          eq(planItems.workspaceId, workspaceId),
          eq(planItems.targetType, kind),
          eq(planItems.targetId, idColumn),
          inArray(planItems.status, [...OPEN_PLAN_ITEM_STATUSES]),
        ),
      ),
  )
}

/**
 * The two sweeps the dashboard deliberately left to this feature: the brief
 * lines the mockup drew from records missing agent fields, and from open
 * pipeline records with nothing planned. Totals are exact so the prompt never
 * understates a backlog; ids are capped at `SIGNAL_ID_LIMIT` and say so.
 */
export async function collectWorkspaceSignals(
  db: Queryable,
  workspaceId: string,
  taskId: string,
): Promise<readonly WorkspaceSignal[]> {
  if (taskId === 'workspace.empty_field_sweep') {
    return [
      await signalOver(
        db,
        'People missing a summary',
        people,
        people.id,
        and(eq(people.workspaceId, workspaceId), eq(people.summary, '')) as SQL,
      ),
      await signalOver(
        db,
        'Companies missing a summary',
        companies,
        companies.id,
        and(eq(companies.workspaceId, workspaceId), eq(companies.summary, '')) as SQL,
      ),
      await signalOver(
        db,
        'Companies missing an ICP fit',
        companies,
        companies.id,
        and(eq(companies.workspaceId, workspaceId), eq(companies.icpFit, 'unknown')) as SQL,
      ),
      await openStageSignal(
        db,
        workspaceId,
        'Open deals missing a summary',
        SWEEP_TABLES.deal,
        eq(deals.summary, ''),
      ),
      await openStageSignal(
        db,
        workspaceId,
        'Open opportunities missing a summary',
        SWEEP_TABLES.opportunity,
        eq(opportunities.summary, ''),
      ),
      await openStageSignal(
        db,
        workspaceId,
        'Open partnerships missing a summary',
        SWEEP_TABLES.partnership,
        eq(partnerships.summary, ''),
      ),
      await openStageSignal(
        db,
        workspaceId,
        'Open raises missing a summary',
        SWEEP_TABLES.raise,
        eq(raises.summary, ''),
      ),
      await openStageSignal(
        db,
        workspaceId,
        'Open raises missing a thesis fit',
        SWEEP_TABLES.raise,
        eq(raises.thesisFit, ''),
      ),
    ]
  }

  if (taskId === 'workspace.pipeline_review') {
    return [
      await openStageSignal(
        db,
        workspaceId,
        'Open deals with no open Plan item',
        SWEEP_TABLES.deal,
        noOpenPlan(db, workspaceId, 'deal', deals.id),
      ),
      await openStageSignal(
        db,
        workspaceId,
        'Open opportunities with no open Plan item',
        SWEEP_TABLES.opportunity,
        noOpenPlan(db, workspaceId, 'opportunity', opportunities.id),
      ),
      await openStageSignal(
        db,
        workspaceId,
        'Open raises with no open Plan item',
        SWEEP_TABLES.raise,
        noOpenPlan(db, workspaceId, 'raise', raises.id),
      ),
      await openStageSignal(
        db,
        workspaceId,
        'Open deals missing a summary',
        SWEEP_TABLES.deal,
        eq(deals.summary, ''),
      ),
      await openStageSignal(
        db,
        workspaceId,
        'Open opportunities missing a summary',
        SWEEP_TABLES.opportunity,
        eq(opportunities.summary, ''),
      ),
      await openStageSignal(
        db,
        workspaceId,
        'Open raises missing a summary',
        SWEEP_TABLES.raise,
        eq(raises.summary, ''),
      ),
    ]
  }

  return []
}

/** The four target types Plan items attach to, per `schema.md`. */
const PLAN_TARGET_TYPES: ReadonlySet<AgentTaskTargetType> = new Set([
  'deal',
  'opportunity',
  'raise',
  'partnership',
])

/**
 * Everything the prompt renderer and the context pack need, or undefined when
 * the target does not resolve inside this workspace.
 */
export async function assemblePromptInputs(
  db: Queryable,
  workspaceId: string,
  definition: AgentTaskDefinition,
  targetType: AgentTaskTargetType,
  targetId: string,
): Promise<PromptInputs | undefined> {
  const meta = await resolveTargetMeta(db, workspaceId, targetType, targetId)

  if (meta === undefined) {
    return undefined
  }

  const [workspace] = await db
    .select({ name: workspaces.name })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))

  if (workspace === undefined) {
    throw new Error(`Workspace ${workspaceId} vanished while resolving a task`)
  }

  const attachable = isRecordTargetType(targetType)

  return {
    workspaceName: workspace.name,
    targetLabel: meta.label,
    deepLink: meta.deepLink,
    handbookPages: await findHandbookPages(db, workspaceId, definition.handbookSlugs),
    pinnedNoteIds: attachable
      ? await collectPinnedNoteIds(db, workspaceId, targetType, targetId)
      : [],
    openDecisionIds: attachable
      ? await collectOpenDecisionIds(db, workspaceId, targetType, targetId)
      : [],
    openPlanIds: PLAN_TARGET_TYPES.has(targetType)
      ? await collectOpenPlanIds(db, workspaceId, targetType, targetId)
      : [],
    related: await collectRelated(db, workspaceId, targetType, targetId),
    signals: await collectWorkspaceSignals(db, workspaceId, definition.id),
  }
}
