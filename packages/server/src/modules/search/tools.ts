import { SEARCH_COLLECTIONS } from '@kelpie/schemas'
import { z } from 'zod'

import { MAX_PAGE_SIZE } from '../../lib/pagination.ts'
import type { McpToolRegistry } from '../../runtime/module.ts'
import { MAX_SEARCH_TERM_LENGTH } from './query.ts'
import { searchResponse } from './routes.ts'
import type { SearchService } from './service.ts'

/**
 * `search_query`, and nothing else. Nothing here writes.
 *
 * Named for what it does rather than for the REST verb. `api.md` builds a tool
 * name from the path segment and the verb, which would give `search_get`; that
 * reads as fetching a saved search, and a tool an agent picks from a list of
 * dozens is chosen by its name before its description.
 *
 * This is the tool an agent reaches for before any of the `*_list` ones: those
 * need to know which resource holds the answer, and a question rarely does.
 */
const queryArgs = z.strictObject({
  q: z
    .string()
    .min(1)
    .max(MAX_SEARCH_TERM_LENGTH)
    .describe('What to search for. Every word is matched as a prefix, so partial words work.'),
  type: z
    .array(z.enum(SEARCH_COLLECTIONS))
    .nonempty()
    .optional()
    .describe('Which collections to look through. Omit to search all nine.'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(MAX_PAGE_SIZE)
    .optional()
    .describe('How many results each group carries. The total beside each group is exact.'),
})

export function registerSearchTools(mcp: McpToolRegistry, service: SearchService): void {
  mcp.tool({
    name: 'search_query',
    description:
      'Search every CRM record and handbook page at once: People (including the job titles on ' +
      'their Positions), Companies, Deals, Opportunities, Raises, Partnerships, Roles, Decisions, ' +
      'and handbook bodies. Deals, Opportunities and Raises also match the titles of their Plan ' +
      'items. Results come back grouped by collection, each group ranked and carrying an exact ' +
      'total, with a snippet centred on the match. Mirrors GET /v1/search.',
    inputSchema: queryArgs,
    invoke: async (args, actor) =>
      searchResponse(
        await service.find(actor, {
          term: args.q,
          limit: args.limit,
          collections: args.type,
        }),
      ),
  })
}
