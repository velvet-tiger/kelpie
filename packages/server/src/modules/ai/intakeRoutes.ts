import {
  PERSON_INTAKE_MAX_TEXT,
  personIntakeCandidateWireSchema,
  personIntakeItemWireSchema,
} from '@kelpie/schemas'
import type { Hono } from 'hono'
import { z } from 'zod'

import { readJsonBody } from '../../lib/http.ts'
import { resolveActorFrom } from '../auth/credentials.ts'
import type { CredentialDependencies } from '../auth/credentials.ts'
import type { PersonIntake } from './intake.ts'

/**
 * `/v1/ai/person-intake/*`. Public API like the rest of the module, behind
 * the same `module.ai` gate. Any member may call it: `apply` writes with the
 * caller's own actor, so the CRUD tools apply their usual role checks.
 */

const notes = z.string().trim().min(1, 'Paste something about the person').max(PERSON_INTAKE_MAX_TEXT)

const identifyBody = z.strictObject({ text: notes })

const researchBody = z.strictObject({
  text: notes,
  candidate: personIntakeCandidateWireSchema,
  existing_person_id: z.string().min(1).nullable().default(null),
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

    return context.json(await dependencies.intake.identify(actor, body.text))
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
    )
  })

  router.post('/ai/person-intake/apply', async (context) => {
    const actor = await resolveActorFrom(dependencies, context)
    const body = await readJsonBody(context, applyBody)

    return context.json({ results: await dependencies.intake.apply(actor, body.items) })
  })
}
