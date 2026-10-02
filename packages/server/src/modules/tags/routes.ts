import { TAG_TARGET_TYPES } from '@kelpie/schemas'
import type { TagTargetType } from '@kelpie/schemas'
import type { Context, Hono } from 'hono'

import { AppError } from '../../lib/errors.ts'
import { readPageSize } from '../../lib/pagination.ts'
import type { Actor } from '../auth/actor.ts'
import { resolveActorFrom } from '../auth/credentials.ts'
import type { CredentialDependencies } from '../auth/credentials.ts'
import { MAX_TAG_TERM_LENGTH } from './service.ts'
import type { TagResults, TagsService } from './service.ts'

/**
 * Wire shape for `GET /v1/tags`.
 *
 * A summary across the `tags` arrays of every taggable record, so it takes the
 * search shape rather than a list's: one object, `?limit=` caps it, no cursor.
 * `?q=` is optional here. An empty one asks for the most used tags, which is
 * what a tag picker shows before anyone types.
 */

export interface TagsRoutesDependencies extends CredentialDependencies {
  readonly service: TagsService
}

function readTerm(context: Context): string | undefined {
  const raw = context.req.query('q')

  if (raw !== undefined && raw.length > MAX_TAG_TERM_LENGTH) {
    throw AppError.validationFailed('"q" is too long', [
      { field: 'q', message: `Use at most ${String(MAX_TAG_TERM_LENGTH)} characters` },
    ])
  }

  return raw
}

const TARGET_TYPES = new Set<string>(TAG_TARGET_TYPES)

function isTagTargetType(value: string): value is TagTargetType {
  return TARGET_TYPES.has(value)
}

/**
 * `?target_type=`, repeatable: naming it twice asks for either. Absent means
 * every taggable type. An unknown value is a 422 rather than an empty list, so
 * a typo cannot pass for a workspace with no tags.
 */
function readTargetTypes(context: Context): readonly TagTargetType[] | undefined {
  const values = context.req.queries('target_type')

  if (values === undefined || values.length === 0) {
    return undefined
  }

  const known = values.filter(isTagTargetType)

  if (known.length !== values.length) {
    throw AppError.validationFailed('"target_type" names a type that carries no tags', [
      { field: 'target_type', message: `Use one of: ${TAG_TARGET_TYPES.join(', ')}` },
    ])
  }

  return [...new Set(known)]
}

function readLimit(context: Context): number | undefined {
  const raw = context.req.query('limit')

  return raw === undefined ? undefined : readPageSize(raw)
}

export function tagsResponse(results: TagResults): Record<string, unknown> {
  return {
    query: results.query,
    limit: results.limit,
    tags: results.tags.map((row) => ({ tag: row.tag, count: row.count })),
  }
}

export function mountTagsRoutes(router: Hono, dependencies: TagsRoutesDependencies): void {
  const requireActor = (context: Context): Promise<Actor> => resolveActorFrom(dependencies, context)

  router.get('/tags', async (context) => {
    // Credentials first, so a caller with none is told that rather than told
    // their query string is malformed.
    const actor = await requireActor(context)

    const results = await dependencies.service.list(actor, {
      term: readTerm(context),
      targetTypes: readTargetTypes(context),
      limit: readLimit(context),
    })

    return context.json(tagsResponse(results))
  })
}
