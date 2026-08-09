import { SEARCH_COLLECTIONS } from '@kelpie/schemas'
import type { SearchCollection } from '@kelpie/schemas'
import type { Context, Hono } from 'hono'

import { AppError } from '../../lib/errors.ts'
import { readPageSize } from '../../lib/pagination.ts'
import type { Actor } from '../auth/actor.ts'
import { resolveActorFrom } from '../auth/credentials.ts'
import type { CredentialDependencies } from '../auth/credentials.ts'
import { MAX_SEARCH_TERM_LENGTH } from './query.ts'
import type { SearchGroup, SearchItem, SearchResults, SearchService } from './service.ts'

/**
 * Wire shape for `GET /v1/search`.
 *
 * One resource made of nine lists, so it takes the dashboard's shape rather than
 * a list's: a bare object, one `?limit=` capping every group, and an exact total
 * beside each capped group. There is no cursor. Paging nine keysets at once is a
 * different feature, and the answer to "too many results" is a better query.
 */

export interface SearchRoutesDependencies extends CredentialDependencies {
  readonly service: SearchService
}

/**
 * `?q=`, required and never blank.
 *
 * `api.md` makes a blank filter value a 422 rather than something to ignore,
 * because an empty search and a search for everything are different questions and
 * only one of them was asked.
 */
function readTerm(context: Context): string {
  const raw = context.req.query('q')

  if (raw === undefined || raw.trim().length === 0) {
    throw AppError.validationFailed('"q" is required', [
      { field: 'q', message: 'Give something to search for' },
    ])
  }

  if (raw.length > MAX_SEARCH_TERM_LENGTH) {
    throw AppError.validationFailed('"q" is too long', [
      { field: 'q', message: `Use at most ${String(MAX_SEARCH_TERM_LENGTH)} characters` },
    ])
  }

  return raw
}

const COLLECTIONS = new Set<string>(SEARCH_COLLECTIONS)

/**
 * `?type=`, repeatable in the same way an id filter is (`api.md`): naming it twice
 * asks for either. Absent means every collection.
 *
 * An unknown value is a 422 rather than an empty group. Silently searching eight
 * collections when nine were named is the kind of answer a caller cannot tell from
 * a genuine miss.
 */
function readCollections(context: Context): readonly SearchCollection[] | undefined {
  const values = context.req.queries('type')

  if (values === undefined || values.length === 0) {
    return undefined
  }

  const unknown = values.filter((value) => !COLLECTIONS.has(value))

  if (unknown.length > 0) {
    throw AppError.validationFailed('"type" names a collection that does not exist', [
      { field: 'type', message: `Use one of: ${SEARCH_COLLECTIONS.join(', ')}` },
    ])
  }

  // Deduplicated, and put back into the canonical order so the groups come back
  // the same way whatever order they were asked for in.
  const named = new Set(values)

  return SEARCH_COLLECTIONS.filter((collection) => named.has(collection))
}

function readLimit(context: Context): number | undefined {
  const raw = context.req.query('limit')

  return raw === undefined ? undefined : readPageSize(raw)
}

function itemBody(item: SearchItem): Record<string, unknown> {
  return {
    id: item.id,
    title: item.title,
    subtitle: item.subtitle,
    snippet: item.snippet,
  }
}

function groupBody(group: SearchGroup): Record<string, unknown> {
  return {
    type: group.collection,
    total: group.total,
    items: group.items.map(itemBody),
  }
}

export function searchResponse(results: SearchResults): Record<string, unknown> {
  return {
    query: results.query,
    limit: results.limit,
    total: results.total,
    groups: results.groups.map(groupBody),
  }
}

export function mountSearchRoutes(router: Hono, dependencies: SearchRoutesDependencies): void {
  const requireActor = (context: Context): Promise<Actor> => resolveActorFrom(dependencies, context)

  router.get('/search', async (context) => {
    // Credentials first. A caller with none should be told that, not told their
    // query string is malformed.
    const actor = await requireActor(context)

    const results = await dependencies.service.find(actor, {
      term: readTerm(context),
      limit: readLimit(context),
      collections: readCollections(context),
    })

    return context.json(searchResponse(results))
  })
}
