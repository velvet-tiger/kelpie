import type { Context, Hono } from 'hono'
import { z } from 'zod'

import { AppError } from '../../lib/errors.ts'
import { pageBody, readJsonBody, readListParameters } from '../../lib/http.ts'
import type { Actor } from '../auth/actor.ts'
import { resolveActorFrom } from '../auth/credentials.ts'
import type { CredentialDependencies } from '../auth/credentials.ts'
import { PIPELINE_KINDS } from './schema.ts'
import type { PipelineKind } from './schema.ts'
import type { PipelineStageView, PipelineStagesService } from './service.ts'

/** Wire shapes for `/v1/pipeline_stages`. Bodies are strict; an unknown field is a 422, per `api.md`. */

const createBody = z.strictObject({
  kind: z.enum(PIPELINE_KINDS),
  label: z.string().min(1),
  open: z.boolean().default(true),
})

/**
 * `label` renames the column, `slug` never moves (imports alias to it), `open`
 * flips the Open-scope visibility, and `sort_order` is the stage's new 0-based
 * position on its board.
 */
const updateBody = z
  .strictObject({
    label: z.string().min(1),
    open: z.boolean(),
    sort_order: z.number().int().min(0),
  })
  .partial()

const kindFilter = z.enum(PIPELINE_KINDS)

export interface PipelinesRoutesDependencies extends CredentialDependencies {
  readonly service: PipelineStagesService
}

function readKindFilter(context: Context): PipelineKind | undefined {
  const raw = context.req.query('kind')

  if (raw === undefined) {
    return undefined
  }

  const parsed = kindFilter.safeParse(raw)

  if (!parsed.success) {
    throw AppError.validationFailed('That pipeline kind does not exist', [
      { field: 'kind', message: `Use one of: ${PIPELINE_KINDS.join(', ')}` },
    ])
  }

  return parsed.data
}

/** `?move_to=` on DELETE: where the removed stage's records go. */
function readMoveTo(context: Context): string | undefined {
  const raw = context.req.query('move_to')

  if (raw === undefined) {
    return undefined
  }

  if (raw.length === 0) {
    throw AppError.validationFailed('"move_to" cannot be blank', [
      { field: 'move_to', message: 'Expected a stage id' },
    ])
  }

  return raw
}

export function stageResponse(stage: PipelineStageView): Record<string, unknown> {
  return {
    id: stage.id,
    kind: stage.kind,
    slug: stage.slug,
    label: stage.label,
    open: stage.open,
    sort_order: stage.sortOrder,
    created_at: stage.createdAt.toISOString(),
    updated_at: stage.updatedAt.toISOString(),
  }
}

export function mountPipelinesRoutes(
  router: Hono,
  dependencies: PipelinesRoutesDependencies,
): void {
  const requireActor = (context: Context): Promise<Actor> => resolveActorFrom(dependencies, context)

  router.get('/pipeline_stages', async (context) => {
    const page = await dependencies.service.list(
      await requireActor(context),
      { kind: readKindFilter(context) },
      readListParameters(context),
    )

    return context.json(pageBody(page, stageResponse))
  })

  router.post('/pipeline_stages', async (context) => {
    const body = await readJsonBody(context, createBody)
    const stage = await dependencies.service.create(await requireActor(context), {
      kind: body.kind,
      label: body.label,
      open: body.open,
    })

    return context.json(stageResponse(stage), 201)
  })

  router.get('/pipeline_stages/:id', async (context) => {
    const stage = await dependencies.service.get(
      await requireActor(context),
      context.req.param('id'),
    )

    return context.json(stageResponse(stage))
  })

  router.patch('/pipeline_stages/:id', async (context) => {
    const body = await readJsonBody(context, updateBody)
    const stage = await dependencies.service.update(
      await requireActor(context),
      context.req.param('id'),
      {
        ...(body.label === undefined ? {} : { label: body.label }),
        ...(body.open === undefined ? {} : { open: body.open }),
        ...(body.sort_order === undefined ? {} : { sortOrder: body.sort_order }),
      },
    )

    return context.json(stageResponse(stage))
  })

  router.delete('/pipeline_stages/:id', async (context) => {
    await dependencies.service.remove(
      await requireActor(context),
      context.req.param('id'),
      readMoveTo(context),
    )

    return context.body(null, 204)
  })
}
