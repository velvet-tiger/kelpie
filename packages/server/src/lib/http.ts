import type { Context } from 'hono'
import type { z } from 'zod'

import { AppError, toErrorDetails } from './errors.ts'
import type { ListQueryParameters, Page } from './pagination.ts'

/** The parsing every route repeats: read the wire, reject it, or hand back a typed value. */

/**
 * Where unauthenticated routes mount (`architecture.md` boot step 5).
 *
 * Shared because two places need to agree on it: the app mounts the public
 * routers here, and a module that builds an absolute URL to one of its own
 * public endpoints has to spell the same prefix.
 */
export const PUBLIC_ROUTE_PREFIX = '/v1/public'

/**
 * The scheme and host a request arrived on.
 *
 * Used to build absolute URLs a customer pastes into their own site. It follows
 * the request rather than configuration, so it is right wherever the service is
 * reached from and needs no new environment variable. Behind a proxy it is only
 * right if that proxy preserves the external `Host`, which is the same condition
 * every redirect and cookie domain already depends on.
 */
export function requestOrigin(context: Context): string {
  return new URL(context.req.url).origin
}

/**
 * Reads and validates a JSON request body.
 *
 * @throws AppError 400 when the body is not JSON at all, 422 when it is JSON the
 *   schema refuses. The two are different client mistakes and `api.md` gives them
 *   different statuses.
 */
export async function readJsonBody<T>(context: Context, schema: z.ZodType<T>): Promise<T> {
  const raw: unknown = await context.req.json().catch(() => {
    throw new AppError('bad_request', 'Body must be valid JSON')
  })
  const parsed = schema.safeParse(raw)

  if (!parsed.success) {
    throw AppError.validationFailed('Request body is invalid', toErrorDetails(parsed.error.issues))
  }

  return parsed.data
}

/** Lifts `?limit=`, `?sort=` and `?cursor=` off a request. Validated where the sort fields are known. */
export function readListParameters(context: Context): ListQueryParameters {
  return {
    limit: context.req.query('limit'),
    sort: context.req.query('sort'),
    cursor: context.req.query('cursor'),
  }
}

/**
 * The most ids one filter may name, matching the `?limit=` ceiling in `api.md`.
 *
 * The two are the same number on purpose. A caller resolving a page of records
 * asks about at most one page of ids, so a filter that allowed fewer would make
 * the maximum page size unusable, and one that allowed more would invite a query
 * no page could have produced.
 */
export const MAX_FILTER_IDS = 200

/**
 * Reads an id filter that may be given more than once: `?person_id=a&person_id=b`.
 *
 * Repeated parameters rather than a comma-separated list, because an id needs no
 * escaping this way and there is no separator to get wrong. One occurrence is
 * the ordinary case and reads the same as it always did.
 *
 * @returns The ids, or undefined when the parameter is absent.
 * @throws AppError 422 for a blank value or more than `MAX_FILTER_IDS` of them.
 *   Silently dropping either would answer a different question than the one asked.
 */
export function readIdFilter(context: Context, name: string): readonly string[] | undefined {
  const values = context.req.queries(name)

  if (values === undefined || values.length === 0) {
    return undefined
  }

  if (values.some((value) => value.length === 0)) {
    throw AppError.validationFailed(`"${name}" cannot be blank`, [
      { field: name, message: 'Expected an id' },
    ])
  }

  if (values.length > MAX_FILTER_IDS) {
    throw AppError.validationFailed(`"${name}" takes at most ${String(MAX_FILTER_IDS)} ids`, [
      { field: name, message: `Given ${String(values.length)}` },
    ])
  }

  return values
}

/** The `{ data, next_cursor }` envelope from `api.md`. */
export function pageBody<T>(
  page: Page<T>,
  render: (item: T) => Record<string, unknown>,
): { data: Record<string, unknown>[]; next_cursor: string | null } {
  return { data: page.items.map(render), next_cursor: page.nextCursor }
}
