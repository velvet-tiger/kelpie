import type { Context, Hono } from 'hono'
import { z } from 'zod'

import { pageBody, readJsonBody, readListParameters } from '../../lib/http.ts'
import type { Actor } from '../auth/actor.ts'
import { resolveActorFrom } from '../auth/credentials.ts'
import type { CredentialDependencies } from '../auth/credentials.ts'
import type { PositionView, PositionsService } from './service.ts'

/** Wire shapes for `/v1/positions`. Bodies are strict; an unknown field is a 422, per `api.md`. */

const createBody = z.strictObject({
  person_id: z.string().min(1),
  company_id: z.string().min(1),
  title: z.string().min(1),
})

/** Only the title. Moving a link to a different person or company is a delete and a create. */
const updateBody = z.strictObject({ title: z.string().min(1) }).partial()

export interface PositionsRoutesDependencies extends CredentialDependencies {
  readonly service: PositionsService
}

export function positionResponse(position: PositionView): Record<string, unknown> {
  return {
    id: position.id,
    person_id: position.personId,
    company_id: position.companyId,
    title: position.title,
    created_at: position.createdAt.toISOString(),
    updated_at: position.updatedAt.toISOString(),
  }
}

export function mountPositionsRoutes(router: Hono, dependencies: PositionsRoutesDependencies): void {
  const requireActor = (context: Context): Promise<Actor> => resolveActorFrom(dependencies, context)

  router.get('/positions', async (context) => {
    const page = await dependencies.service.list(
      await requireActor(context),
      {
        personId: context.req.query('person_id'),
        companyId: context.req.query('company_id'),
      },
      readListParameters(context),
    )

    return context.json(pageBody(page, positionResponse))
  })

  router.post('/positions', async (context) => {
    const body = await readJsonBody(context, createBody)
    const position = await dependencies.service.create(await requireActor(context), {
      personId: body.person_id,
      companyId: body.company_id,
      title: body.title,
    })

    return context.json(positionResponse(position), 201)
  })

  router.get('/positions/:id', async (context) => {
    const position = await dependencies.service.get(
      await requireActor(context),
      context.req.param('id'),
    )

    return context.json(positionResponse(position))
  })

  router.patch('/positions/:id', async (context) => {
    const body = await readJsonBody(context, updateBody)
    const position = await dependencies.service.update(
      await requireActor(context),
      context.req.param('id'),
      { ...(body.title === undefined ? {} : { title: body.title }) },
    )

    return context.json(positionResponse(position))
  })

  router.delete('/positions/:id', async (context) => {
    await dependencies.service.remove(await requireActor(context), context.req.param('id'))

    return context.body(null, 204)
  })
}
