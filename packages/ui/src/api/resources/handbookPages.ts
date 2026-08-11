import { createHandbookPageBody, handbookPageBody, handbookPageSchema } from '@kelpie/schemas'
import type { CreateHandbookPageInput, HandbookPage, HandbookPageInput } from '@kelpie/schemas'

import type { QueryParameters } from '../client.ts'
import { createResourceHooks } from '../resource.ts'
import type {
  MutationResult,
  RecordListResult,
  RecordResult,
  UpdateArguments,
} from '../resource.ts'

/**
 * `/v1/handbook_pages`: the workspace handbook, as a flat list the sidebar
 * builds a tree from.
 */

const pages = createResourceHooks<HandbookPage, CreateHandbookPageInput, HandbookPageInput>({
  name: 'handbook_pages',
  path: '/handbook_pages',
  decode: handbookPageSchema.parse,
  createBody: createHandbookPageBody,
  updateBody: handbookPageBody,
})

/** The documented filters on `GET /v1/handbook_pages`. */
export interface HandbookPageFilters {
  /** Matches a page's title and its body. A handbook is searched for what it says. */
  readonly term?: string | undefined
  /** Pages at these slugs. Repeats on the wire. */
  readonly slugs?: readonly string[] | undefined
  readonly limit?: number | undefined
}

function handbookQuery(filters: HandbookPageFilters): QueryParameters {
  return { q: filters.term, slug: filters.slugs, limit: filters.limit }
}

/**
 * The whole handbook, at the documented page maximum.
 *
 * The same call the kanban board makes for its stages, for the same reason: a
 * tree cannot be drawn from part of itself, and a page whose parent is on the
 * next page of results would render at the top level as though somebody had
 * moved it there. The caller reads `hasMore` and says so rather than drawing a
 * tree with holes in it.
 */
export function useHandbookPages(filters: HandbookPageFilters = {}): RecordListResult<HandbookPage> {
  return pages.useList(handbookQuery({ limit: 200, ...filters }))
}

export function useHandbookPage(id: string | undefined): RecordResult<HandbookPage> {
  return pages.useRecord(id)
}

export function useCreateHandbookPage(): MutationResult<CreateHandbookPageInput, HandbookPage> {
  return pages.useCreate()
}

export function useUpdateHandbookPage(): MutationResult<
  UpdateArguments<HandbookPageInput>,
  HandbookPage
> {
  return pages.useUpdate()
}

/**
 * Deletes a page and, by cascade, every page nested under it.
 *
 * The optimistic removal in `createResourceHooks` takes the clicked page out of
 * the cached list and leaves its subpages behind for the moment it takes the
 * refetch to land. The sidebar therefore renders from the tree it can build,
 * which drops a subtree whose parent is gone rather than floating it to the top.
 */
export function useDeleteHandbookPage(): MutationResult<string, void> {
  return pages.useRemove()
}
