import type { TagTargetType } from '@kelpie/schemas'
import { asc, desc, eq, sql } from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'
import { unionAll } from 'drizzle-orm/pg-core'
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core'

import type { Queryable } from '../../runtime/transaction.ts'
import { companies } from '../companies/schema.ts'
import { deals } from '../deals/schema.ts'
import { enquiries } from '../enquiries/schema.ts'
import { events } from '../events/schema.ts'
import { forms } from '../forms/schema.ts'
import { opportunities } from '../opportunities/schema.ts'
import { partnerships } from '../partnerships/schema.ts'
import { people } from '../people/schema.ts'
import { raises } from '../raises/schema.ts'

/**
 * One `tags` array column to read, and whether its entries count as uses.
 *
 * A Form's `person_tags` and `company_tags` are tags the form will set on a
 * submitter, so they are worth suggesting before anyone has submitted. They are
 * not records carrying the tag, so they add the tag at a count of zero.
 */
interface TagSource {
  readonly table: PgTable
  readonly workspaceId: PgColumn
  readonly tags: PgColumn
  readonly counts: boolean
}

const SOURCES: Readonly<Record<TagTargetType, readonly TagSource[]>> = {
  person: [
    { table: people, workspaceId: people.workspaceId, tags: people.tags, counts: true },
    { table: forms, workspaceId: forms.workspaceId, tags: forms.personTags, counts: false },
  ],
  company: [
    { table: companies, workspaceId: companies.workspaceId, tags: companies.tags, counts: true },
    { table: forms, workspaceId: forms.workspaceId, tags: forms.companyTags, counts: false },
  ],
  enquiry: [
    { table: enquiries, workspaceId: enquiries.workspaceId, tags: enquiries.tags, counts: true },
  ],
  deal: [{ table: deals, workspaceId: deals.workspaceId, tags: deals.tags, counts: true }],
  opportunity: [
    {
      table: opportunities,
      workspaceId: opportunities.workspaceId,
      tags: opportunities.tags,
      counts: true,
    },
  ],
  raise: [{ table: raises, workspaceId: raises.workspaceId, tags: raises.tags, counts: true }],
  partnership: [
    {
      table: partnerships,
      workspaceId: partnerships.workspaceId,
      tags: partnerships.tags,
      counts: true,
    },
  ],
  event: [{ table: events, workspaceId: events.workspaceId, tags: events.tags, counts: true }],
}

export interface TagRow {
  readonly tag: string
  readonly count: number
}

export interface TagQuery {
  readonly workspaceId: string
  readonly targetTypes: readonly TagTargetType[]
  /** Case-insensitive substring. Null matches every tag. */
  readonly term: string | null
  readonly limit: number
}

/**
 * Distinct tags across the named record types, most used first.
 *
 * Substring rather than prefix, because a tag is often two words and a reader
 * remembers the second one. `strpos` over `lower()` rather than `ILIKE`, so a
 * `%` or `_` in the term is a character to find and not a wildcard.
 */
export async function listTags(db: Queryable, query: TagQuery): Promise<readonly TagRow[]> {
  const selects = query.targetTypes
    .flatMap((type) => SOURCES[type])
    .map((source) =>
      db
        .select({
          tag: sql<string>`unnest(${source.tags})`.as('tag'),
          uses: sql<number>`${sql.raw(source.counts ? '1' : '0')}`.as('uses'),
        })
        .from(source.table)
        .where(eq(source.workspaceId, query.workspaceId)),
    )

  const [first, second, ...rest] = selects

  if (first === undefined) {
    return []
  }

  const used = (second === undefined ? first : unionAll(first, second, ...rest)).as('used')
  const count = sql<number>`sum(${used.uses})::int`.mapWith(Number)
  const filter: SQL | undefined =
    query.term === null ? undefined : sql`strpos(lower(${used.tag}), lower(${query.term})) > 0`

  const rows = await db
    .select({ tag: used.tag, count })
    .from(used)
    .where(filter)
    .groupBy(used.tag)
    .orderBy(desc(count), asc(used.tag))
    .limit(query.limit)

  return rows
}
