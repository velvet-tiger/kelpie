import { z } from 'zod'

import { idSchema } from './wire.ts'

/**
 * The wire shape of a Kelpie event.
 *
 * Every event, no matter which module publishes it, uses the same envelope. The
 * `data` field is the module-defined payload; everything else is universal so
 * webhooks, MCP consumers, and downstream handlers can read the envelope without
 * knowing which event type they are looking at.
 */

/**
 * Who caused the event.
 *
 * A user or an agent carries the actor id. A system actor is the server acting
 * on its own (a background job, a scheduled task) and has no identity.
 */
export const eventActorSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('user'), id: idSchema }),
  z.object({ kind: z.literal('agent'), id: idSchema }),
  z.object({ kind: z.literal('system') }),
])

export type EventActor = z.infer<typeof eventActorSchema>

/**
 * What the event refers to. `type` is the CRM object type (`person`, `deal`,
 * ...); `id` is its primary key.
 */
export const eventTargetSchema = z.object({
  type: z.string().min(1),
  id: idSchema,
})

export type EventTarget = z.infer<typeof eventTargetSchema>

/**
 * The universal fields around a module's `data`.
 *
 * `data` is left unknown here because the wire schema is not tied to any one
 * module's catalog; a consumer that wants to type it dispatches on `name`.
 */
export const eventEnvelopeSchema = z.object({
  id: idSchema,
  name: z.string().min(1),
  workspaceId: idSchema,
  actor: eventActorSchema,
  occurredAt: z.iso.datetime(),
  target: eventTargetSchema,
  causedBy: idSchema.optional(),
  data: z.unknown(),
})

/**
 * The strongly-typed event as it moves through the in-process bus. The wire
 * schema erases `data`; this generic keeps it typed for the module that owns
 * the event.
 */
export interface KelpieEvent<Name extends string, Data> {
  readonly id: string
  readonly name: Name
  readonly workspaceId: string
  readonly actor: EventActor
  readonly occurredAt: string
  readonly target: EventTarget
  readonly causedBy?: string
  readonly data: Data
}

/**
 * Builds a Zod schema for the payload of an update event. `changed` is what
 * the emitter observed; `before` and `after` carry only those fields plus the
 * primary key, so payloads stay small and subscribers can filter on `changed`
 * without diffing again.
 */
export function updateEventSchema<Fields extends z.ZodObject<z.ZodRawShape>>(fields: Fields) {
  return z.object({
    before: fields.partial(),
    after: fields.partial(),
    changed: z.array(z.string()),
  })
}

export interface UpdateEventData<Fields> {
  readonly before: Partial<Fields>
  readonly after: Partial<Fields>
  readonly changed: readonly string[]
}
