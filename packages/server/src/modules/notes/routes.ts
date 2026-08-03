import type { Context, Hono } from 'hono'
import { z } from 'zod'

import { AppError } from '../../lib/errors.ts'
import { pageBody, readJsonBody, readListParameters } from '../../lib/http.ts'
import type { Actor } from '../auth/actor.ts'
import { resolveActorFrom } from '../auth/credentials.ts'
import type { CredentialDependencies } from '../auth/credentials.ts'
import { isRecordTargetType } from '../recordTargets.ts'
import type { RecordTargetType } from '../recordTargets.ts'
import { RECORD_TARGET_TYPES } from './schema.ts'
import type { NoteView, NotesService } from './service.ts'

/**
 * Wire shapes for `/v1/notes`.
 *
 * Bodies are strict: `api.md` makes an unknown field a 422 rather than something
 * dropped in silence.
 */

const createBody = z.strictObject({
  target_type: z.enum(RECORD_TARGET_TYPES),
  target_id: z.string().min(1),
  body: z.string().min(1),
  pinned: z.boolean().default(false),
})

/** The target never moves. Re-filing a note under another record is a delete and a create. */
const updateBody = z
  .strictObject({
    body: z.string().min(1),
    pinned: z.boolean(),
  })
  .partial()

export interface NotesRoutesDependencies extends CredentialDependencies {
  readonly service: NotesService
}

export function noteResponse(note: NoteView): Record<string, unknown> {
  return {
    id: note.id,
    target_type: note.targetType,
    target_id: note.targetId,
    body: note.body,
    author_id: note.authorId,
    pinned: note.pinned,
    created_at: note.createdAt.toISOString(),
    updated_at: note.updatedAt.toISOString(),
  }
}

/**
 * A note list always names the record it belongs to. There is no workspace-wide
 * note list in the mockup, and answering one by accident through an omitted
 * filter would page a workspace's entire note history to render one panel.
 *
 * @throws AppError 422 when either half is missing, the type is unknown, or
 *   `?pinned=` is a word that is not true or false.
 */
function readFilters(context: Context): {
  targetType: RecordTargetType
  targetId: string
  pinned: boolean | undefined
} {
  const targetType = context.req.query('target_type')
  const targetId = context.req.query('target_id')

  if (targetType === undefined || targetId === undefined || targetId.length === 0) {
    throw AppError.validationFailed('A note list is always a list for one record', [
      { field: 'target_type', message: 'Required' },
      { field: 'target_id', message: 'Required' },
    ])
  }

  if (!isRecordTargetType(targetType)) {
    throw AppError.validationFailed('That is not a record type a note attaches to', [
      { field: 'target_type', message: `Unknown target type "${targetType}"` },
    ])
  }

  return { targetType, targetId, pinned: readPinned(context.req.query('pinned')) }
}

function readPinned(raw: string | undefined): boolean | undefined {
  if (raw === undefined) {
    return undefined
  }

  if (raw === 'true') {
    return true
  }

  if (raw === 'false') {
    return false
  }

  // Not defaulted to false: `?pinned=yes` asked a question, and answering the
  // unpinned one instead is worse than saying the question was malformed.
  throw AppError.validationFailed('"pinned" filters on true or false', [
    { field: 'pinned', message: `Expected true or false, got "${raw}"` },
  ])
}

export function mountNotesRoutes(router: Hono, dependencies: NotesRoutesDependencies): void {
  const requireActor = (context: Context): Promise<Actor> => resolveActorFrom(dependencies, context)

  router.get('/notes', async (context) => {
    const page = await dependencies.service.list(
      await requireActor(context),
      readFilters(context),
      readListParameters(context),
    )

    return context.json(pageBody(page, noteResponse))
  })

  router.post('/notes', async (context) => {
    const body = await readJsonBody(context, createBody)
    const note = await dependencies.service.create(await requireActor(context), {
      targetType: body.target_type,
      targetId: body.target_id,
      body: body.body,
      pinned: body.pinned,
    })

    return context.json(noteResponse(note), 201)
  })

  router.get('/notes/:id', async (context) => {
    const note = await dependencies.service.get(await requireActor(context), context.req.param('id'))

    return context.json(noteResponse(note))
  })

  router.patch('/notes/:id', async (context) => {
    const body = await readJsonBody(context, updateBody)
    const note = await dependencies.service.update(
      await requireActor(context),
      context.req.param('id'),
      {
        ...(body.body === undefined ? {} : { body: body.body }),
        ...(body.pinned === undefined ? {} : { pinned: body.pinned }),
      },
    )

    return context.json(noteResponse(note))
  })

  router.delete('/notes/:id', async (context) => {
    await dependencies.service.remove(await requireActor(context), context.req.param('id'))

    return context.body(null, 204)
  })
}
