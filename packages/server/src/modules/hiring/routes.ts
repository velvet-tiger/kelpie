import type { Context, Hono } from 'hono'
import { z } from 'zod'

import { AppError } from '../../lib/errors.ts'
import { pageBody, readIdFilter, readJsonBody, readListParameters } from '../../lib/http.ts'
import type { Actor } from '../auth/actor.ts'
import { resolveActorFrom } from '../auth/credentials.ts'
import type { CredentialDependencies } from '../auth/credentials.ts'
import type {
  CandidateView,
  CandidatesService,
  CreateCandidateInput,
  UpdateCandidateInput,
} from './candidates.ts'
import type { CreateRoleInput, RoleView, RolesService, UpdateRoleInput } from './roles.ts'
import { CANDIDATE_STATUSES, INTERVIEW_STAGES, ROLE_STATUSES } from './schema.ts'

/**
 * Wire shapes for `/v1/roles` and `/v1/candidates`. Bodies are strict; an
 * unknown field is a 422, per `api.md`.
 */

const roleShape = {
  title: z.string().min(1),
  status: z.enum(ROLE_STATUSES),
}

/** Only a title is required. A role exists because it is open, so that is the default. */
const createRoleBody = z.strictObject({
  ...roleShape,
  status: roleShape.status.default('open'),
})

const updateRoleBody = z.strictObject(roleShape).partial()

const candidateShape = {
  role_id: z.string().min(1),
  person_id: z.string().min(1),
  status: z.enum(CANDIDATE_STATUSES),
  interview_stage: z.enum(INTERVIEW_STAGES).nullable(),
  referrer_person_id: z.string().min(1).nullable(),
}

/**
 * Both ends are required; nothing else is. An absent status starts the candidacy
 * in process, where the mockup's "Add candidate" puts one, and an absent stage
 * lands at the first, which the service resolves along with the rule that ties
 * the two together.
 */
const createCandidateBody = z.strictObject({
  ...candidateShape,
  status: candidateShape.status.default('in_process'),
  interview_stage: candidateShape.interview_stage.optional(),
  referrer_person_id: candidateShape.referrer_person_id.default(null),
})

/** Neither end. Repointing a candidacy is a delete and a create, as with a Position. */
const updateCandidateBody = z
  .strictObject({
    status: candidateShape.status,
    interview_stage: candidateShape.interview_stage,
    referrer_person_id: candidateShape.referrer_person_id,
  })
  .partial()

export interface HiringRoutesDependencies extends CredentialDependencies {
  readonly roles: RolesService
  readonly candidates: CandidatesService
}

/**
 * An enum filter, validated rather than matched against nothing.
 *
 * `readIdFilter` handles the repeat-to-name-a-set shape; what it cannot know is
 * which values exist. An unknown one is a `422` here for the same reason it is
 * in a body: silently answering "no records" would report a typo as an empty
 * pipeline.
 */
function readEnumFilter<Value extends string>(
  context: Context,
  name: string,
  allowed: readonly Value[],
): readonly Value[] | undefined {
  const values = readIdFilter(context, name)

  if (values === undefined) {
    return undefined
  }

  const unknown = values.filter((value) => !allowed.includes(value as Value))

  if (unknown.length > 0) {
    throw AppError.validationFailed(`"${name}" does not take ${unknown.join(', ')}`, [
      { field: name, message: `Expected one of ${allowed.join(', ')}` },
    ])
  }

  return values as readonly Value[]
}

function toCreateRoleInput(body: z.infer<typeof createRoleBody>): CreateRoleInput {
  return { title: body.title, status: body.status }
}

function toUpdateRoleInput(body: z.infer<typeof updateRoleBody>): UpdateRoleInput {
  return {
    ...(body.title === undefined ? {} : { title: body.title }),
    ...(body.status === undefined ? {} : { status: body.status }),
  }
}

export function roleResponse(role: RoleView): Record<string, unknown> {
  return {
    id: role.id,
    title: role.title,
    status: role.status,
    created_at: role.createdAt.toISOString(),
    updated_at: role.updatedAt.toISOString(),
  }
}

function toCreateCandidateInput(
  body: z.infer<typeof createCandidateBody>,
): CreateCandidateInput {
  return {
    roleId: body.role_id,
    personId: body.person_id,
    status: body.status,
    interviewStage: body.interview_stage,
    referrerPersonId: body.referrer_person_id,
  }
}

function toUpdateCandidateInput(
  body: z.infer<typeof updateCandidateBody>,
): UpdateCandidateInput {
  return {
    ...(body.status === undefined ? {} : { status: body.status }),
    ...(body.interview_stage === undefined ? {} : { interviewStage: body.interview_stage }),
    ...(body.referrer_person_id === undefined
      ? {}
      : { referrerPersonId: body.referrer_person_id }),
  }
}

export function candidateResponse(candidate: CandidateView): Record<string, unknown> {
  return {
    id: candidate.id,
    role_id: candidate.roleId,
    person_id: candidate.personId,
    status: candidate.status,
    interview_stage: candidate.interviewStage,
    referrer_person_id: candidate.referrerPersonId,
    created_at: candidate.createdAt.toISOString(),
    updated_at: candidate.updatedAt.toISOString(),
  }
}

export function mountHiringRoutes(router: Hono, dependencies: HiringRoutesDependencies): void {
  const requireActor = (context: Context): Promise<Actor> => resolveActorFrom(dependencies, context)

  router.get('/roles', async (context) => {
    const page = await dependencies.roles.list(
      await requireActor(context),
      {
        term: context.req.query('q'),
        statuses: readEnumFilter(context, 'status', ROLE_STATUSES),
      },
      readListParameters(context),
    )

    return context.json(pageBody(page, roleResponse))
  })

  router.post('/roles', async (context) => {
    const body = await readJsonBody(context, createRoleBody)
    const role = await dependencies.roles.create(
      await requireActor(context),
      toCreateRoleInput(body),
    )

    return context.json(roleResponse(role), 201)
  })

  router.get('/roles/:id', async (context) => {
    const role = await dependencies.roles.get(await requireActor(context), context.req.param('id'))

    return context.json(roleResponse(role))
  })

  router.patch('/roles/:id', async (context) => {
    const body = await readJsonBody(context, updateRoleBody)
    const role = await dependencies.roles.update(
      await requireActor(context),
      context.req.param('id'),
      toUpdateRoleInput(body),
    )

    return context.json(roleResponse(role))
  })

  router.delete('/roles/:id', async (context) => {
    await dependencies.roles.remove(await requireActor(context), context.req.param('id'))

    return context.body(null, 204)
  })

  router.get('/candidates', async (context) => {
    const page = await dependencies.candidates.list(
      await requireActor(context),
      {
        roleIds: readIdFilter(context, 'role_id'),
        personIds: readIdFilter(context, 'person_id'),
        statuses: readEnumFilter(context, 'status', CANDIDATE_STATUSES),
      },
      readListParameters(context),
    )

    return context.json(pageBody(page, candidateResponse))
  })

  router.post('/candidates', async (context) => {
    const body = await readJsonBody(context, createCandidateBody)
    const candidate = await dependencies.candidates.create(
      await requireActor(context),
      toCreateCandidateInput(body),
    )

    return context.json(candidateResponse(candidate), 201)
  })

  router.get('/candidates/:id', async (context) => {
    const candidate = await dependencies.candidates.get(
      await requireActor(context),
      context.req.param('id'),
    )

    return context.json(candidateResponse(candidate))
  })

  router.patch('/candidates/:id', async (context) => {
    const body = await readJsonBody(context, updateCandidateBody)
    const candidate = await dependencies.candidates.update(
      await requireActor(context),
      context.req.param('id'),
      toUpdateCandidateInput(body),
    )

    return context.json(candidateResponse(candidate))
  })

  router.delete('/candidates/:id', async (context) => {
    await dependencies.candidates.remove(await requireActor(context), context.req.param('id'))

    return context.body(null, 204)
  })
}
