import { WEBHOOK_EVENTS } from '@kelpie/schemas'
import type { WebhookEvent } from '@kelpie/schemas'

import type { DomainEvents, EventBus } from '../../runtime/events.ts'

/**
 * The bridge from the internal event catalog to what a webhook receiver sees.
 *
 * `modules.md` makes the webhooks engine a consumer of the bus, so this is the
 * only place that knows both vocabularies. Everything downstream works with a
 * `WebhookEventPayload` and never sees a `DomainEvents` key.
 *
 * Payload keys are `snake_case`, matching `api.md`, because a receiver has no
 * reason to expect a different convention from a webhook than from the REST
 * surface it also calls.
 */

export { WEBHOOK_EVENTS }
export type { WebhookEvent }

/** One event, resolved to the workspace it belongs to and the body to send. */
export interface WebhookEventPayload {
  readonly workspaceId: string
  readonly event: WebhookEvent
  /** The `data` object of the delivery body. */
  readonly data: Record<string, unknown>
}

/**
 * Payload builders, one per deliverable event.
 *
 * `satisfies` is what keeps this honest: adding a name to `WEBHOOK_EVENTS`
 * without a builder here is a compile error rather than an event that resolves
 * to nothing at runtime.
 */
const builders = {
  'record.created': (payload: DomainEvents['record.created']): WebhookEventPayload => ({
    workspaceId: payload.workspaceId,
    event: 'record.created',
    data: { object_type: payload.objectType, record_id: payload.recordId },
  }),

  'record.updated': (payload: DomainEvents['record.updated']): WebhookEventPayload => ({
    workspaceId: payload.workspaceId,
    event: 'record.updated',
    data: {
      object_type: payload.objectType,
      record_id: payload.recordId,
      // The values stay as the emitting service named them, which is camelCase
      // (`parentId`, `sortOrder`) even though the keys around them are not.
      // Translating them to the wire spelling would mean a second copy of every
      // module's column naming, kept in step by hand.
      changed_fields: [...payload.changedFields],
    },
  }),

  'record.deleted': (payload: DomainEvents['record.deleted']): WebhookEventPayload => ({
    workspaceId: payload.workspaceId,
    event: 'record.deleted',
    data: { object_type: payload.objectType, record_id: payload.recordId },
  }),

  'form.submitted': (payload: DomainEvents['form.submitted']): WebhookEventPayload => ({
    workspaceId: payload.workspaceId,
    event: 'form.submitted',
    data: { form_id: payload.formId, submission_id: payload.submissionId },
  }),
} satisfies { [Name in WebhookEvent]: (payload: DomainEvents[Name]) => WebhookEventPayload }

/**
 * Subscribes the engine to every deliverable event.
 *
 * Written out one call at a time rather than looped over `WEBHOOK_EVENTS`,
 * because TypeScript cannot correlate a payload type with a generic key: a loop
 * would need a cast, and the cast is exactly what would let a wrong payload
 * through. A literal key indexes `builders` at its precise signature.
 */
export function subscribeDeliverableEvents(
  bus: EventBus,
  deliver: (payload: WebhookEventPayload) => Promise<void>,
): void {
  bus.subscribe('record.created', (payload) => deliver(builders['record.created'](payload)))
  bus.subscribe('record.updated', (payload) => deliver(builders['record.updated'](payload)))
  bus.subscribe('record.deleted', (payload) => deliver(builders['record.deleted'](payload)))
  bus.subscribe('form.submitted', (payload) => deliver(builders['form.submitted'](payload)))
}
