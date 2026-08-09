import { SEARCH_COLLECTIONS } from '@kelpie/schemas'
import type { SearchCollection } from '@kelpie/schemas'

import type { Database } from '../../lib/database.ts'
import type { Actor } from '../auth/actor.ts'
import { requireWorkspaceId } from '../auth/actor.ts'
import { searchWords, snippet, toTsQuery } from './query.ts'
import {
  compileQuery,
  searchCompanies,
  searchDeals,
  searchDecisions,
  searchHandbookPages,
  searchOpportunities,
  searchPartnerships,
  searchPeople,
  searchRaises,
  searchRoles,
} from './repository.ts'
import type { CollectionHits } from './repository.ts'

/**
 * One box across nine collections, ranked per collection rather than merged.
 *
 * A single merged ranking would need `ts_rank` values from different tables to
 * mean the same thing, and they do not: a handbook page is a thousand words and a
 * Role is three. Grouping is also what the reader wants, because "which Deal" and
 * "which handbook page" are different questions.
 */

export interface SearchItem {
  readonly id: string
  readonly title: string
  /** The record's one line of context. What it holds depends on the collection. */
  readonly subtitle: string | null
  /** A fragment of the record's prose, centred on the match. Empty when it has none. */
  readonly snippet: string
}

export interface SearchGroup {
  readonly collection: SearchCollection
  /** Every match, not just the ones in `items`. */
  readonly total: number
  readonly items: readonly SearchItem[]
}

export interface SearchResults {
  readonly query: string
  readonly limit: number
  /** Across every group. The number a "12 results" heading is built from. */
  readonly total: number
  /** Always all nine, in `SEARCH_COLLECTIONS` order, empty ones included. */
  readonly groups: readonly SearchGroup[]
}

export interface SearchRequest {
  readonly term: string
  readonly limit?: number | undefined
  /** Which collections to look through. Absent means all of them. */
  readonly collections?: readonly SearchCollection[] | undefined
}

export interface SearchService {
  find(actor: Actor, request: SearchRequest): Promise<SearchResults>
}

export interface SearchServiceDependencies {
  readonly db: Database
}

/**
 * How many rows a group carries when the caller does not say.
 *
 * Small on purpose: nine groups on one page, and a reader scanning them wants the
 * best few of each rather than a page of People they have to scroll past to reach
 * the handbook. The exact total sits beside each group regardless.
 */
export const DEFAULT_SEARCH_LIMIT = 10

type CollectionSearch = (
  db: Database,
  workspaceId: string,
  query: ReturnType<typeof compileQuery>,
  limit: number,
) => Promise<CollectionHits>

const SEARCHES: Readonly<Record<SearchCollection, CollectionSearch>> = {
  handbook_page: searchHandbookPages,
  person: searchPeople,
  role: searchRoles,
  company: searchCompanies,
  deal: searchDeals,
  opportunity: searchOpportunities,
  raise: searchRaises,
  partnership: searchPartnerships,
  decision: searchDecisions,
}

/** A term that tokenises to nothing still answers, with every group empty. */
function emptyResults(term: string, limit: number, wanted: readonly SearchCollection[]): SearchResults {
  return {
    query: term,
    limit,
    total: 0,
    groups: wanted.map((collection) => ({ collection, total: 0, items: [] })),
  }
}

function toGroup(hits: CollectionHits, words: readonly string[]): SearchGroup {
  return {
    collection: hits.collection,
    total: hits.total,
    items: hits.hits.map((hit) => ({
      id: hit.id,
      title: hit.title,
      subtitle: hit.subtitle,
      snippet: hit.snippetSource === null ? '' : snippet(hit.snippetSource, words),
    })),
  }
}

export function createSearchService(dependencies: SearchServiceDependencies): SearchService {
  return {
    async find(actor, request) {
      const workspaceId = requireWorkspaceId(actor)
      const limit = request.limit ?? DEFAULT_SEARCH_LIMIT
      const wanted = request.collections ?? SEARCH_COLLECTIONS
      const tsQuery = toTsQuery(request.term)

      if (tsQuery === null) {
        return emptyResults(request.term, limit, wanted)
      }

      const query = compileQuery(tsQuery)
      const words = searchWords(request.term)

      // Nine independent reads with nothing to share but the compiled query. Run
      // in sequence they would be nine round trips deep rather than wide.
      const groups = await Promise.all(
        wanted.map(async (collection) =>
          toGroup(await SEARCHES[collection](dependencies.db, workspaceId, query, limit), words),
        ),
      )

      return {
        query: request.term,
        limit,
        total: groups.reduce((sum, group) => sum + group.total, 0),
        groups,
      }
    },
  }
}
