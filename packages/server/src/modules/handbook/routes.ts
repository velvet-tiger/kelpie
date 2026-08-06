import type { Context, Hono } from 'hono'
import { z } from 'zod'

import { pageBody, readIdFilter, readJsonBody, readListParameters } from '../../lib/http.ts'
import type { Actor } from '../auth/actor.ts'
import { resolveActorFrom } from '../auth/credentials.ts'
import type { CredentialDependencies } from '../auth/credentials.ts'
import { MAX_SLUG_LENGTH, SLUG_PATTERN } from './slugs.ts'
import type {
  CreateHandbookPageInput,
  HandbookPageView,
  HandbookService,
  UpdateHandbookPageInput,
} from './service.ts'

/**
 * Wire shapes for `/v1/handbook_pages`. Bodies are strict; an unknown field is a
 * 422, per `api.md`.
 */

const slugField = z
  .string()
  .min(1)
  .max(MAX_SLUG_LENGTH)
  .regex(SLUG_PATTERN, 'Use lowercase words joined by hyphens')

/**
 * `slug` is optional on both verbs and stays put on a rename.
 *
 * The mockup rewrites a page's slug every time its title is edited. Agent tasks
 * name handbook pages by slug (`agent-tasks.md`), so a slug that follows the
 * title would break a task definition the first time somebody fixes a typo. This
 * is the rule pipeline stages already follow: the label renames, the import alias
 * does not. Moving a slug on purpose is a separate field in the same request.
 */
export const createBody = z.strictObject({
  title: z.string().min(1),
  body: z.string().default(''),
  slug: slugField.optional(),
  parent_id: z.string().min(1).nullable().default(null),
})

/**
 * `parent_id` and `sort_order` are the move. `null` on `parent_id` lifts a page
 * to the top level, which is what `api.md` says null means on a nullable field.
 */
export const updateBody = z
  .strictObject({
    title: z.string().min(1),
    body: z.string(),
    slug: slugField,
    parent_id: z.string().min(1).nullable(),
    sort_order: z.number().int().min(0),
  })
  .partial()

export interface HandbookRoutesDependencies extends CredentialDependencies {
  readonly service: HandbookService
}

export function toCreateInput(body: z.infer<typeof createBody>): CreateHandbookPageInput {
  return {
    title: body.title,
    body: body.body,
    slug: body.slug,
    parentId: body.parent_id,
  }
}

export function toUpdateInput(body: z.infer<typeof updateBody>): UpdateHandbookPageInput {
  return {
    ...(body.title === undefined ? {} : { title: body.title }),
    ...(body.body === undefined ? {} : { body: body.body }),
    ...(body.slug === undefined ? {} : { slug: body.slug }),
    ...(body.parent_id === undefined ? {} : { parentId: body.parent_id }),
    ...(body.sort_order === undefined ? {} : { sortOrder: body.sort_order }),
  }
}

export function handbookPageResponse(page: HandbookPageView): Record<string, unknown> {
  return {
    id: page.id,
    title: page.title,
    slug: page.slug,
    parent_id: page.parentId,
    sort_order: page.sortOrder,
    body: page.body,
    updated_by: page.updatedBy,
    created_at: page.createdAt.toISOString(),
    updated_at: page.updatedAt.toISOString(),
  }
}

export function mountHandbookRoutes(router: Hono, dependencies: HandbookRoutesDependencies): void {
  const requireActor = (context: Context): Promise<Actor> => resolveActorFrom(dependencies, context)

  router.get('/handbook_pages', async (context) => {
    const page = await dependencies.service.list(
      await requireActor(context),
      {
        term: context.req.query('q'),
        // `readIdFilter` despite these being slugs: the shape is the one it
        // enforces — repeatable, blank refused, capped at a page of them — and a
        // task resolving its `handbookSlugs` asks about a set exactly that way.
        slugs: readIdFilter(context, 'slug'),
      },
      readListParameters(context),
    )

    return context.json(pageBody(page, handbookPageResponse))
  })

  router.post('/handbook_pages', async (context) => {
    const body = await readJsonBody(context, createBody)
    const page = await dependencies.service.create(await requireActor(context), toCreateInput(body))

    return context.json(handbookPageResponse(page), 201)
  })

  router.get('/handbook_pages/:id', async (context) => {
    const page = await dependencies.service.get(
      await requireActor(context),
      context.req.param('id'),
    )

    return context.json(handbookPageResponse(page))
  })

  router.patch('/handbook_pages/:id', async (context) => {
    const body = await readJsonBody(context, updateBody)
    const page = await dependencies.service.update(
      await requireActor(context),
      context.req.param('id'),
      toUpdateInput(body),
    )

    return context.json(handbookPageResponse(page))
  })

  router.delete('/handbook_pages/:id', async (context) => {
    await dependencies.service.remove(await requireActor(context), context.req.param('id'))

    return context.body(null, 204)
  })
}
