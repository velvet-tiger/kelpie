import type { Context, Hono } from 'hono'
import { z } from 'zod'

import { AppError, toErrorDetails } from '../../lib/errors.ts'
import type { Actor } from '../auth/actor.ts'
import { resolveActorFrom } from '../auth/credentials.ts'
import type { CredentialDependencies } from '../auth/credentials.ts'
import { KEY_KINDS } from './keys.ts'
import type { ApiKeyService, ApiKeyView, MintedApiKey } from './service.ts'

/** Wire shapes for `/v1/api-keys`. */

const createBody = z.object({
  name: z.string().min(1),
  kind: z.enum(KEY_KINDS),
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
    )

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
