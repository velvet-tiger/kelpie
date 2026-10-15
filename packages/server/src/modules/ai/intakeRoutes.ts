import {
  PERSON_INTAKE_MAX_TEXT,
  personIntakeCandidateWireSchema,
  personIntakeItemWireSchema,
} from '@kelpie/schemas'
import type { Hono } from 'hono'
import { z } from 'zod'

import { AppError } from '../../lib/errors.ts'
import { readJsonBody } from '../../lib/http.ts'
import { resolveActorFrom } from '../auth/credentials.ts'
import type { CredentialDependencies } from '../auth/credentials.ts'
import type { PersonIntake } from './intake.ts'
import { MAX_ID_LENGTH } from '../../lib/fieldLimits.ts'

/**
 * `/v1/ai/person-intake/*`. Public API like the rest of the module, behind
 * the same `module.ai` gate. Any member may call it: `apply` writes with the
 * caller's own actor, so the CRUD tools apply their usual role checks.
 *
 * `identify` and `research` answer `202` with `{ run_id }`; the caller reads
 * `GET /ai/person-intake/runs/:id` until the run settles. Only the caller who
 * started a run can read it.
 */

const notes = z.string().trim().min(1, 'Paste something about the person').max(PERSON_INTAKE_MAX_TEXT)

const identifyBody = z.strictObject({ text: notes })

const researchBody = z.strictObject({
  text: notes,
  candidate: personIntakeCandidateWireSchema,
  existing_person_id: z.string().min(1).max(MAX_ID_LENGTH).nullable().default(null),
})

const applyBody = z.strictObject({
  items: z.array(personIntakeItemWireSchema).min(1, 'Choose at least one item').max(30),
})

export interface PersonIntakeRoutesDependencies extends CredentialDependencies {
  readonly intake: PersonIntake
}

export function mountPersonIntakeRoutes(router: Hono, dependencies: PersonIntakeRoutesDependencies): void {
  router.post('/ai/person-intake/identify', async (context) => {
    const actor = await resolveActorFrom(dependencies, context)
    const body = await readJsonBody(context, identifyBody)

    return context.json(await dependencies.intake.identify(actor, body.text), 202)
  })

  router.post('/ai/person-intake/research', async (context) => {
    const actor = await resolveActorFrom(dependencies, context)
    const body = await readJsonBody(context, researchBody)

    return context.json(
      await dependencies.intake.research(actor, {
        text: body.text,
        candidate: body.candidate,
        existingPersonId: body.existing_person_id,
      }),
      202,
    )
  })

  router.get('/ai/person-intake/runs/:id', async (context) => {
    const actor = await resolveActorFrom(dependencies, context)
    const id = context.req.param('id')

    // An id no run could have is a 404 like any other unknown id.
    if (id.length > MAX_ID_LENGTH) {
      throw AppError.notFound('No person-intake run has that id')
    }

    return context.json(await dependencies.intake.readRun(actor, id))
  })

  router.post('/ai/person-intake/apply', async (context) => {
    const actor = await resolveActorFrom(dependencies, context)
    const body = await readJsonBody(context, applyBody)

    return context.json({ results: await dependencies.intake.apply(actor, body.items) })
  })
}
