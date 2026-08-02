import type { Context } from 'hono'
import type { z } from 'zod'

import { AppError, toErrorDetails } from './errors.ts'
import type { ListQueryParameters, Page } from './pagination.ts'

/** The parsing every route repeats: read the wire, reject it, or hand back a typed value. */

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

/** The `{ data, next_cursor }` envelope from `api.md`. */
export function pageBody<T>(
  page: Page<T>,
  render: (item: T) => Record<string, unknown>,
): { data: Record<string, unknown>[]; next_cursor: string | null } {
  return { data: page.items.map(render), next_cursor: page.nextCursor }
}
