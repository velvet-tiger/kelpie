import { composeName, customFieldsPatchShape } from '@kelpie/schemas'
import type { NameParts } from '@kelpie/schemas'
import type { Context, Hono } from 'hono'
import { z } from 'zod'

import { pageBody, readIdFilter, readJsonBody, readListParameters } from '../../lib/http.ts'
import type { Actor } from '../auth/actor.ts'
import { resolveActorFrom } from '../auth/credentials.ts'
import type { CredentialDependencies } from '../auth/credentials.ts'
import { renderCustomFieldsForWire } from '../custom-fields/wire.ts'
import {
  INFLUENCE_LEVELS,
  PREFERRED_CHANNELS,
  RELATIONSHIP_LEVELS,
  SOCIAL_NETWORK_IDS,
} from './schema.ts'
import type { CreatePersonInput, PeopleService, PersonView, UpdatePersonInput } from './service.ts'

/**
 * Wire shapes for `/v1/people`.
 *
 * Bodies are strict: `api.md` makes an unknown field a 422 rather than something
 * dropped in silence, because a client misspelling `summry` should hear about it
 * on the first request, not on the day someone notices the field is empty.
 */

const socialProfileBody = z.strictObject({
  network: z.enum(SOCIAL_NETWORK_IDS),
  url: z.string().min(1),
})

/** The name parts of a body, under the names `composeName` reads them by. */
function toNameParts(body: {
  readonly first_name?: string | null
  readonly last_name?: string | null
  readonly suffix?: string | null
}): NameParts {
  return { firstName: body.first_name, lastName: body.last_name, suffix: body.suffix }
}

/** The full field set, without defaults. `createBody` adds those; `updateBody` makes it partial. */
const personShape = {
  name: z.string().min(1),
  salutation: z.string().nullable(),
  first_name: z.string().nullable(),
  last_name: z.string().nullable(),
  suffix: z.string().nullable(),
  email: z.string().nullable(),
  phones: z.array(z.string().min(1)),
  social_profiles: z.array(socialProfileBody),
  timezone: z.string().nullable(),
  location: z.string().nullable(),
  preferred_channel: z.enum(PREFERRED_CHANNELS),
  influence: z.enum(INFLUENCE_LEVELS),
  relationship: z.enum(RELATIONSHIP_LEVELS),
  summary: z.string(),
  tags: z.array(z.string().min(1)),
  last_contacted_at: z.iso.datetime().nullable(),
  custom_fields: customFieldsPatchShape,
}

/**
 * A create names its person and defaults everything else. The defaults are the
 * ones the mockup's own Add person button writes, so creating through the API and
 * creating through the UI produce the same record.
 *
 * Naming the person means `name`, or the `first_name` / `last_name` pair for one
 * to be composed from — the shape a caller holding a row out of another CRM
 * already has. Sending neither is the one refusal, because `name` is what every
 * list, picker and timeline in Kelpie renders and a blank one is a record nobody
 * can pick out again.
 */
export const createBody = z
  .strictObject({
    ...personShape,
    name: personShape.name.optional(),
    salutation: personShape.salutation.default(null),
    first_name: personShape.first_name.default(null),
    last_name: personShape.last_name.default(null),
    suffix: personShape.suffix.default(null),
    email: personShape.email.default(null),
    phones: personShape.phones.default([]),
    social_profiles: personShape.social_profiles.default([]),
    timezone: personShape.timezone.default(null),
    location: personShape.location.default(null),
    preferred_channel: personShape.preferred_channel.default('email'),
    influence: personShape.influence.default('influencer'),
    relationship: personShape.relationship.default('cold'),
    summary: personShape.summary.default(''),
    tags: personShape.tags.default([]),
    last_contacted_at: personShape.last_contacted_at.default(null),
    custom_fields: personShape.custom_fields.default({}),
  })
  .superRefine((body, context) => {
    if (body.name !== undefined || composeName(toNameParts(body)).length > 0) {
      return
    }

    context.addIssue({
      code: 'custom',
      path: ['name'],
      message: 'Send a name, or a first_name or last_name to compose one from',
    })
  })

export const updateBody = z.strictObject(personShape).partial()

export interface PeopleRoutesDependencies extends CredentialDependencies {
  readonly service: PeopleService
}

export function toCreateInput(body: z.infer<typeof createBody>): CreatePersonInput {
  return {
    // Composed only here, on the way in, and only when the caller sent no name.
    // `createBody` has already refused a body that would leave this blank.
    name: body.name ?? composeName(toNameParts(body)),
    salutation: body.salutation,
    firstName: body.first_name,
    lastName: body.last_name,
    suffix: body.suffix,
    email: body.email,
    phones: body.phones,
    socialProfiles: body.social_profiles,
    timezone: body.timezone,
    location: body.location,
    preferredChannel: body.preferred_channel,
    influence: body.influence,
    relationship: body.relationship,
    summary: body.summary,
    tags: body.tags,
    lastContactedAt: body.last_contacted_at === null ? null : new Date(body.last_contacted_at),
    customFields: body.custom_fields,
  }
}

/**
 * A patch changes exactly the fields it names.
 *
 * Sending `first_name` alone does **not** recompute `name`. A display name is
 * something somebody chose — "Chris" for a Christopher, a married name, a
 * transliteration — and silently rewriting it from a part would undo that
 * choice from across the room. Renaming is `name`, which is one more field in
 * the same request for a caller that wants both.
 */
export function toUpdateInput(body: z.infer<typeof updateBody>): UpdatePersonInput {
  return {
    ...(body.name === undefined ? {} : { name: body.name }),
    ...(body.salutation === undefined ? {} : { salutation: body.salutation }),
    ...(body.first_name === undefined ? {} : { firstName: body.first_name }),
    ...(body.last_name === undefined ? {} : { lastName: body.last_name }),
    ...(body.suffix === undefined ? {} : { suffix: body.suffix }),
    ...(body.email === undefined ? {} : { email: body.email }),
    ...(body.phones === undefined ? {} : { phones: body.phones }),
    ...(body.social_profiles === undefined ? {} : { socialProfiles: body.social_profiles }),
    ...(body.timezone === undefined ? {} : { timezone: body.timezone }),
    ...(body.location === undefined ? {} : { location: body.location }),
    ...(body.preferred_channel === undefined ? {} : { preferredChannel: body.preferred_channel }),
    ...(body.influence === undefined ? {} : { influence: body.influence }),
    ...(body.relationship === undefined ? {} : { relationship: body.relationship }),
    ...(body.summary === undefined ? {} : { summary: body.summary }),
    ...(body.tags === undefined ? {} : { tags: body.tags }),
    ...(body.last_contacted_at === undefined
      ? {}
      : {
          lastContactedAt:
            body.last_contacted_at === null ? null : new Date(body.last_contacted_at),
        }),
    ...(body.custom_fields === undefined ? {} : { customFields: body.custom_fields }),
  }
}

export function personResponse(person: PersonView): Record<string, unknown> {
  return {
    id: person.id,
    name: person.name,
    salutation: person.salutation,
    first_name: person.firstName,
    last_name: person.lastName,
    suffix: person.suffix,
    email: person.email,
    phones: person.phones,
    social_profiles: person.socialProfiles,
    timezone: person.timezone,
    location: person.location,
    preferred_channel: person.preferredChannel,
    influence: person.influence,
    relationship: person.relationship,
    summary: person.summary,
    tags: person.tags,
    last_contacted_at: person.lastContactedAt === null ? null : person.lastContactedAt.toISOString(),
    custom_fields: renderCustomFieldsForWire(person.customFields),
    created_at: person.createdAt.toISOString(),
    updated_at: person.updatedAt.toISOString(),
  }
}

export function mountPeopleRoutes(router: Hono, dependencies: PeopleRoutesDependencies): void {
  const requireActor = (context: Context): Promise<Actor> => resolveActorFrom(dependencies, context)

  router.get('/people', async (context) => {
    const page = await dependencies.service.list(
      await requireActor(context),
      {
        term: context.req.query('q'),
        companyIds: readIdFilter(context, 'company_id'),
      },
      readListParameters(context),
    )

    return context.json(pageBody(page, personResponse))
  })

  router.post('/people', async (context) => {
    const body = await readJsonBody(context, createBody)
    const person = await dependencies.service.create(await requireActor(context), toCreateInput(body))

    return context.json(personResponse(person), 201)
  })

  router.get('/people/:id', async (context) => {
    const person = await dependencies.service.get(await requireActor(context), context.req.param('id'))

    return context.json(personResponse(person))
  })

  router.patch('/people/:id', async (context) => {
    const body = await readJsonBody(context, updateBody)
    const person = await dependencies.service.update(
      await requireActor(context),
      context.req.param('id'),
      toUpdateInput(body),
    )

    return context.json(personResponse(person))
  })

  router.delete('/people/:id', async (context) => {
    await dependencies.service.remove(await requireActor(context), context.req.param('id'))

    return context.body(null, 204)
  })
}
