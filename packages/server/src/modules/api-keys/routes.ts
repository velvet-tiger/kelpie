import { API_KEY_SCOPES } from '@kelpie/schemas'
import type { Context, Hono } from 'hono'
import { z } from 'zod'

import { AppError, toErrorDetails } from '../../lib/errors.ts'
import { withholdFromReplay } from '../../lib/http.ts'
import type { Actor } from '../auth/actor.ts'
import { resolveActorFrom } from '../auth/credentials.ts'
import type { CredentialDependencies } from '../auth/credentials.ts'
import { KEY_KINDS } from './keys.ts'
import type { ApiKeyService, ApiKeyView, MintedApiKey } from './service.ts'
import {
  MAX_LIST_ITEMS,
  MAX_SHORT_TEXT_LENGTH,
} from '../../lib/fieldLimits.ts'

/** Wire shapes for `/v1/api-keys`. */

/**
 * `scopes` absent or empty gives the default scopes. `full_access: true`
 * gives every scope, and the service refuses it together with `scopes`.
 */
const createBody = z.object({
  name: z.string().min(1).max(MAX_SHORT_TEXT_LENGTH),
  kind: z.enum(KEY_KINDS),
  scopes: z.array(z.enum(API_KEY_SCOPES)).max(MAX_LIST_ITEMS).optional(),
  full_access: z.boolean().optional(),
})

const listQuery = z.object({ kind: z.enum(KEY_KINDS) })

export interface ApiKeyRoutesDependencies extends CredentialDependencies {
  readonly service: ApiKeyService
}

async function readBody<T>(context: Context, schema: z.ZodType<T>): Promise<T> {
  const raw: unknown = await context.req.json().catch(() => {
    throw new AppError('bad_request', 'Body must be valid JSON')
  })
  const parsed = schema.safeParse(raw)

  if (!parsed.success) {
    throw AppError.validationFailed('Request body is invalid', toErrorDetails(parsed.error.issues))
  }

  return parsed.data
}

function keyResponse(key: ApiKeyView): Record<string, unknown> {
  return {
    id: key.id,
    name: key.name,
    kind: key.kind,
    scopes: key.scopes,
    display_prefix: key.displayPrefix,
    last_used_at: key.lastUsedAt === null ? null : key.lastUsedAt.toISOString(),
    created_at: key.createdAt.toISOString(),
  }
}

export function mountApiKeyRoutes(router: Hono, dependencies: ApiKeyRoutesDependencies): void {
  const requireActor = (context: Context): Promise<Actor> => resolveActorFrom(dependencies, context)

  /** The response carries `secret`. No later request can retrieve it. */
  router.post('/api-keys', async (context) => {
    const body = await readBody(context, createBody)
    const minted: MintedApiKey = await dependencies.service.create(
      await requireActor(context),
      body.name,
      body.kind,
      { scopes: body.scopes, fullAccess: body.full_access === true },
    )

    withholdFromReplay(context)

    return context.json({ ...keyResponse(minted), secret: minted.secret }, 201)
  })

  router.get('/api-keys', async (context) => {
    const parsed = listQuery.safeParse({ kind: context.req.query('kind') })

    if (!parsed.success) {
      throw AppError.validationFailed(
        'Specify which keys to list',
        toErrorDetails(parsed.error.issues),
      )
    }

    const keys = await dependencies.service.list(await requireActor(context), parsed.data.kind)

    return context.json({ data: keys.map(keyResponse), next_cursor: null })
  })

  router.delete('/api-keys/:id', async (context) => {
    await dependencies.service.revoke(await requireActor(context), context.req.param('id'))

    return context.body(null, 204)
  })
}
