import type { SearchCollection } from '@kelpie/schemas'
import { and, asc, desc, eq, max, sql } from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'
import { unionAll } from 'drizzle-orm/pg-core'
import type { PgColumn } from 'drizzle-orm/pg-core'

import type { Queryable } from '../../runtime/transaction.ts'
import { companies } from '../companies/schema.ts'
import { deals } from '../deals/schema.ts'
import { decisions } from '../decisions/schema.ts'
import { handbookPages } from '../handbook/schema.ts'
import { roles } from '../hiring/schema.ts'
import { opportunities } from '../opportunities/schema.ts'
import { partnerships } from '../partnerships/schema.ts'
import { people } from '../people/schema.ts'
import { pipelineStages } from '../pipelines/schema.ts'
import { planItems } from '../plans/schema.ts'
import { positions } from '../positions/schema.ts'
import { raises } from '../raises/schema.ts'

/**
 * The reads behind `GET /v1/search`: one query per collection, each against that
 * collection's own `search_vector` GIN index.
 *
 * Eleven tables and no repository imports, the same licence `dashboard` takes and
 * for the same reason. A search that composed nine repositories would ask each of
 * them for a page it then had to re-rank, and none of them can rank at all.
 *
 * **Every branch of every query has to be indexable.** Four collections match on a
 * second table as well: a Person is found by a job title that lives on Position,
 * and a Deal, Opportunity or Raise by a step that lives on Plan. Written as
 * `own_vector @@ q OR EXISTS (…)` that is a sequential scan, because Postgres will
 * not use an index for an `OR` whose other branch is a subquery. Written as a
 * `UNION ALL` of two matches, each branch uses its own index and the ranks are
 * merged afterwards. That is why the shape below looks indirect.
 */

/** A row on its way to becoming a result. `subtitle` and `snippet` are per collection. */
export interface SearchHit {
  readonly id: string
  readonly title: string
  readonly subtitle: string | null
  readonly snippetSource: string | null
}

/** What one collection answered: a capped, ranked page and the exact number of matches. */
export interface CollectionHits {
  readonly collection: SearchCollection
  readonly hits: readonly SearchHit[]
  readonly total: number
}

/**
 * How far a match on a related record sits below a match on the record itself.
 *
 * A Deal whose own summary says "renewal" is a better answer than one with a
 * planned step that mentions it. Without this they interleave by `ts_rank` alone,
 * which compares the wrong two things: one rank is over the record, the other over
 * a single line attached to it.
 */
const RELATED_RANK_FACTOR = 0.4

/** The compiled `tsquery`, built once per request and shared by every collection. */
export function compileQuery(tsQuery: string): SQL {
  return sql`to_tsquery('english', ${tsQuery})`
}

function matches(vector: PgColumn, query: SQL): SQL {
  return sql`${vector} @@ ${query}`
}

function rank(vector: PgColumn, query: SQL): SQL<number> {
  return sql<number>`ts_rank(${vector}, ${query})`
}

function relatedRank(vector: PgColumn, query: SQL): SQL<number> {
  return sql<number>`ts_rank(${vector}, ${query}) * ${RELATED_RANK_FACTOR}`
}

/**
 * The number of matching records, which is not the number of rows returned.
 *
 * A window function is evaluated before `LIMIT`, so this counts every group the
 * query found and the page below it stays capped. `api.md` has no envelope for
 * this endpoint and the dashboard's precedent is an exact total beside a short
 * list, because a capped list cannot answer "how many".
 *
 * Cast to `int` because `count` is `bigint`, and postgres.js hands a bigint back
 * as a string rather than losing precision on it. Summing those gives `'01'`
 * instead of `1`, which is a wrong number rather than a type error.
 */
const total = sql<number>`(count(*) over ())::int`

/** Rows are grouped by id, so a record matching on both itself and a related row appears once. */
function bestRank(rankColumn: PgColumn | SQL.Aliased<number>): SQL<number> {
  return sql<number>`${max(rankColumn)}`
}

export async function searchHandbookPages(
  db: Queryable,
  workspaceId: string,
  query: SQL,
  limit: number,
): Promise<CollectionHits> {
  const rows = await db
    .select({
      id: handbookPages.id,
      title: handbookPages.title,
      subtitle: handbookPages.slug,
      snippetSource: handbookPages.body,
      total,
    })
    .from(handbookPages)
    .where(and(eq(handbookPages.workspaceId, workspaceId), matches(handbookPages.searchVector, query)))
    .orderBy(desc(rank(handbookPages.searchVector, query)), asc(handbookPages.id))
    .limit(limit)

  return collect('handbook_page', rows)
}

export async function searchPeople(
  db: Queryable,
  workspaceId: string,
  query: SQL,
  limit: number,
): Promise<CollectionHits> {
  const own = db
    .select({ id: people.id, rank: rank(people.searchVector, query).as('rank') })
    .from(people)
    .where(and(eq(people.workspaceId, workspaceId), matches(people.searchVector, query)))

  // A person is found by the title they hold, which is on Position and never on
  // Person (`brief.md`). `?q=` on people already reaches the same way.
  const byTitle = db
    .select({ id: positions.personId, rank: relatedRank(positions.searchVector, query).as('rank') })
    .from(positions)
    .where(and(eq(positions.workspaceId, workspaceId), matches(positions.searchVector, query)))

  const hits = unionAll(own, byTitle).as('hits')

  const rows = await db
    .select({
      id: people.id,
      title: people.name,
      subtitle: people.email,
      snippetSource: people.summary,
      total,
    })
    .from(hits)
    .innerJoin(people, eq(people.id, hits.id))
    .groupBy(people.id)
    .orderBy(desc(bestRank(hits.rank)), asc(people.id))
    .limit(limit)

  return collect('person', rows)
}

export async function searchRoles(
  db: Queryable,
  workspaceId: string,
  query: SQL,
  limit: number,
): Promise<CollectionHits> {
  const rows = await db
    .select({
      id: roles.id,
      title: roles.title,
      subtitle: roles.status,
      // A Role is a title and a status. There is no prose on it to excerpt.
      snippetSource: sql<string | null>`null::text`,
      total,
    })
    .from(roles)
    .where(and(eq(roles.workspaceId, workspaceId), matches(roles.searchVector, query)))
    .orderBy(desc(rank(roles.searchVector, query)), asc(roles.id))
    .limit(limit)

  return collect('role', rows)
}

export async function searchCompanies(
  db: Queryable,
  workspaceId: string,
  query: SQL,
  limit: number,
): Promise<CollectionHits> {
  const rows = await db
    .select({
      id: companies.id,
      title: companies.name,
      subtitle: companies.domain,
      snippetSource: companies.summary,
      total,
    })
    .from(companies)
    .where(and(eq(companies.workspaceId, workspaceId), matches(companies.searchVector, query)))
    .orderBy(desc(rank(companies.searchVector, query)), asc(companies.id))
    .limit(limit)

  return collect('company', rows)
}

/**
 * A Deal, Opportunity or Raise found by one of its Plan items.
 *
 * `plan_items` is polymorphic with no foreign key, so the target type is part of
 * the match rather than something a join expresses.
 */
function byPlanItem(
  db: Queryable,
  workspaceId: string,
  query: SQL,
  targetType: 'deal' | 'opportunity' | 'raise',
) {
  return db
    .select({ id: planItems.targetId, rank: relatedRank(planItems.searchVector, query).as('rank') })
    .from(planItems)
    .where(
      and(
        eq(planItems.workspaceId, workspaceId),
        eq(planItems.targetType, targetType),
        matches(planItems.searchVector, query),
      ),
    )
}

export async function searchDeals(
  db: Queryable,
  workspaceId: string,
  query: SQL,
  limit: number,
): Promise<CollectionHits> {
  const own = db
    .select({ id: deals.id, rank: rank(deals.searchVector, query).as('rank') })
    .from(deals)
    .where(and(eq(deals.workspaceId, workspaceId), matches(deals.searchVector, query)))

  const hits = unionAll(own, byPlanItem(db, workspaceId, query, 'deal')).as('hits')

  const rows = await db
    .select({
      id: deals.id,
      title: deals.name,
      subtitle: pipelineStages.label,
      snippetSource: deals.summary,
      total,
    })
    .from(hits)
    .innerJoin(deals, eq(deals.id, hits.id))
    .innerJoin(pipelineStages, eq(pipelineStages.id, deals.stageId))
    .groupBy(deals.id, pipelineStages.label)
    .orderBy(desc(bestRank(hits.rank)), asc(deals.id))
    .limit(limit)

  return collect('deal', rows)
}

export async function searchOpportunities(
  db: Queryable,
  workspaceId: string,
  query: SQL,
  limit: number,
): Promise<CollectionHits> {
  const own = db
    .select({ id: opportunities.id, rank: rank(opportunities.searchVector, query).as('rank') })
    .from(opportunities)
    .where(and(eq(opportunities.workspaceId, workspaceId), matches(opportunities.searchVector, query)))

  const hits = unionAll(own, byPlanItem(db, workspaceId, query, 'opportunity')).as('hits')

  const rows = await db
    .select({
      id: opportunities.id,
      title: opportunities.name,
      subtitle: opportunities.kind,
      snippetSource: opportunities.summary,
      total,
    })
    .from(hits)
    .innerJoin(opportunities, eq(opportunities.id, hits.id))
    .groupBy(opportunities.id)
    .orderBy(desc(bestRank(hits.rank)), asc(opportunities.id))
    .limit(limit)

  return collect('opportunity', rows)
}

export async function searchRaises(
  db: Queryable,
  workspaceId: string,
  query: SQL,
  limit: number,
): Promise<CollectionHits> {
  const own = db
    .select({ id: raises.id, rank: rank(raises.searchVector, query).as('rank') })
    .from(raises)
    .where(and(eq(raises.workspaceId, workspaceId), matches(raises.searchVector, query)))

  const hits = unionAll(own, byPlanItem(db, workspaceId, query, 'raise')).as('hits')

  const rows = await db
    .select({
      id: raises.id,
      title: raises.name,
      subtitle: pipelineStages.label,
      snippetSource: raises.summary,
      total,
    })
    .from(hits)
    .innerJoin(raises, eq(raises.id, hits.id))
    .innerJoin(pipelineStages, eq(pipelineStages.id, raises.stageId))
    .groupBy(raises.id, pipelineStages.label)
    .orderBy(desc(bestRank(hits.rank)), asc(raises.id))
    .limit(limit)

  return collect('raise', rows)
}

export async function searchPartnerships(
  db: Queryable,
  workspaceId: string,
  query: SQL,
  limit: number,
): Promise<CollectionHits> {
  const rows = await db
    .select({
      id: partnerships.id,
      title: partnerships.name,
      subtitle: partnerships.kind,
      snippetSource: partnerships.summary,
      total,
    })
    .from(partnerships)
    .where(and(eq(partnerships.workspaceId, workspaceId), matches(partnerships.searchVector, query)))
    .orderBy(desc(rank(partnerships.searchVector, query)), asc(partnerships.id))
    .limit(limit)

  return collect('partnership', rows)
}

export async function searchDecisions(
  db: Queryable,
  workspaceId: string,
  query: SQL,
  limit: number,
): Promise<CollectionHits> {
  const rows = await db
    .select({
      id: decisions.id,
      title: decisions.body,
      // The date it was decided, as `YYYY-MM-DD`. A decision has no name and no
      // stage; when it was made is the line the mockup shows beside it.
      subtitle: sql<string>`to_char(${decisions.decidedAt} at time zone 'UTC', 'YYYY-MM-DD')`,
      snippetSource: decisions.rationale,
      total,
    })
    .from(decisions)
    .where(and(eq(decisions.workspaceId, workspaceId), matches(decisions.searchVector, query)))
    .orderBy(desc(rank(decisions.searchVector, query)), asc(decisions.id))
    .limit(limit)

  return collect('decision', rows)
}

interface HitRow {
  readonly id: string
  readonly title: string
  readonly subtitle: string | null
  readonly snippetSource: string | null
  readonly total: number
}

/**
 * `count(*) over ()` is on every row, so an empty page carries no total at all.
 * That is the only case where zero is the right answer.
 */
function collect(collection: SearchCollection, rows: readonly HitRow[]): CollectionHits {
  return {
    collection,
    hits: rows.map(({ id, title, subtitle, snippetSource }) => ({
      id,
      title,
      subtitle,
      snippetSource,
    })),
    total: rows[0]?.total ?? 0,
  }
}
