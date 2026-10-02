import { TAG_TARGET_TYPES } from '@kelpie/schemas'
import { z } from 'zod'

import { MAX_PAGE_SIZE } from '../../lib/pagination.ts'
import type { McpToolRegistry } from '../../runtime/module.ts'
import { tagsResponse } from './routes.ts'
import { MAX_TAG_TERM_LENGTH } from './service.ts'
import type { TagsService } from './service.ts'

/**
 * `tags_list`, and nothing else. A tag is written through the record that
 * carries it, so there is no tool that writes one here.
 *
 * An agent reads this before it tags a record, so it reuses "investor" rather
 * than inventing "Investors" beside it.
 */
const listArgs = z.strictObject({
  target_type: z
    .array(z.enum(TAG_TARGET_TYPES))
    .nonempty()
    .optional()
    .describe('Which record types to read tags from. Omit for every type that carries tags.'),
  q: z
    .string()
    .max(MAX_TAG_TERM_LENGTH)
    .optional()
    .describe('Case-insensitive substring to filter tags by. Omit for the most used tags.'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(MAX_PAGE_SIZE)
    .optional()
    .describe('How many tags to return. Defaults to 20.'),
})

export function registerTagsTools(mcp: McpToolRegistry, service: TagsService): void {
  mcp.tool({
    name: 'tags_list',
    description:
      'List the tags already in use on People, Companies, Enquiries, Deals, Opportunities, ' +
      'Raises, Partnerships and Events, with how many records carry each, most used first. ' +
      'Tags that a Form will set count for person and company at zero. Read this before ' +
      'tagging a record, and reuse an existing tag rather than adding a near-duplicate. ' +
      'Mirrors GET /v1/tags.',
    inputSchema: listArgs,
    invoke: async (args, actor) =>
      tagsResponse(
        await service.list(actor, {
          targetTypes: args.target_type,
          term: args.q,
          limit: args.limit,
        }),
      ),
  })
}
