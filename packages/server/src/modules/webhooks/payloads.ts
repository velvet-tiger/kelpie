import type { KelpieEvent, WebhookEvent } from '@kelpie/schemas'

import type { EventBus } from '../../runtime/events.ts'
import { RECORD_OBJECT_TYPES } from '../../runtime/events.ts'
import type { RecordObjectType } from '../../runtime/events.ts'

/**
 * The bridge from the internal event catalog to what a webhook receiver sees.
 *
 * `modules.md` makes the webhooks engine a consumer of the bus, so this is the
 * only place that knows both vocabularies. Everything downstream works with a
 * `WebhookEventPayload` and never sees an internal event key.
 *
 * A single prefix subscribe (`''`) sees every envelope event, and the
 * translator below decides whether the event corresponds to a deliverable wire
 * event. Unrecognised names are dropped, so a module's private events (a
 * `.stage_changed` on a deal, a `.added` on a note) never reach a receiver
 * that never subscribed to them.
 *
 * Payload keys are `snake_case`, matching `api.md`, because a receiver has no
 * reason to expect a different convention from a webhook than from the REST
 * surface it also calls.
 */

export type { WebhookEvent }

/** One event, resolved to the workspace it belongs to and the body to send. */
export interface WebhookEventPayload {
  readonly workspaceId: string
  readonly event: WebhookEvent
  /** The `data` object of the delivery body. */
  readonly data: Record<string, unknown>
}

const recordObjectTypes = new Set<string>(RECORD_OBJECT_TYPES)

interface RecordUpdatedData {
  readonly changed?: readonly string[]
}

interface FormSubmittedData {
  readonly formId?: string
  readonly submissionId?: string
  readonly opportunityId?: string | null
  readonly partnershipId?: string | null
  readonly enquiryId?: string | null
  readonly actions?: readonly { readonly action: string; readonly status: string }[]
}

/**
 * Translates an envelope event into a `WebhookEventPayload`, or `undefined` if
 * the event does not correspond to any deliverable wire event.
 *
 * The last segment of the event name (`.created`, `.updated`, `.deleted`,
 * `.submitted`) picks the wire event. A `.created`/`.updated`/`.deleted` event
 * is only translated when its target type is one of the CRM record objects
 * (`RECORD_OBJECT_TYPES`), because those are the only ones the wire catalog
 * offers. Everything else is skipped.
 */
export function translateEnvelopeEvent(
  event: KelpieEvent<string, unknown>,
): WebhookEventPayload | undefined {
  const suffix = event.name.slice(event.name.lastIndexOf('.') + 1)
  const objectType = event.target.type

  if (suffix === 'created' || suffix === 'deleted') {
    if (!recordObjectTypes.has(objectType)) {
      return undefined
    }

    return {
      workspaceId: event.workspaceId,
      event: suffix === 'created' ? 'record.created' : 'record.deleted',
      data: { object_type: objectType as RecordObjectType, record_id: event.target.id },
    }
  }

  if (suffix === 'updated') {
    if (!recordObjectTypes.has(objectType)) {
      return undefined
    }

    const data = event.data as RecordUpdatedData
    return {
      workspaceId: event.workspaceId,
      event: 'record.updated',
      data: {
        object_type: objectType as RecordObjectType,
        record_id: event.target.id,
        changed_fields: data.changed !== undefined ? [...data.changed] : [],
      },
    }
  }

  if (suffix === 'submitted') {
    // Form submission is the only `.submitted` wire event today. The forms
    // module emits its envelope with `formId` and `submissionId` in `data`,
    // plus (per forms.md §Webhooks) the opportunity/partnership ids the
    // post-submit runner created and one status per configured action. The
    // per-action `detail` string is deliberately omitted — the authenticated
    // Submissions read carries it in full, the webhook only says what ran.
    const data = event.data as FormSubmittedData
    if (data.formId === undefined || data.submissionId === undefined) {
      return undefined
    }

    return {
      workspaceId: event.workspaceId,
      event: 'form.submitted',
      data: {
        form_id: data.formId,
        submission_id: data.submissionId,
        opportunity_id: data.opportunityId ?? null,
        partnership_id: data.partnershipId ?? null,
        enquiry_id: data.enquiryId ?? null,
        actions:
          data.actions === undefined
            ? []
            : data.actions.map((entry) => ({ action: entry.action, status: entry.status })),
      },
    }
  }

  return undefined
}

/**
 * Subscribes the engine to every deliverable event through one prefix match on
 * `''`, which every envelope event starts with. The translator inside decides
 * whether the event corresponds to a deliverable wire event; unrecognised
 * names are dropped.
 */
export function subscribeDeliverableEvents(
  bus: EventBus,
  deliver: (payload: WebhookEventPayload) => Promise<void>,
): void {
  bus.subscribePrefix(
    '',
    async (event) => {
      const built = translateEnvelopeEvent(event)
      if (built === undefined) {
        return
      }
      await deliver(built)
    },
    { label: 'webhooks:envelope-bridge' },
  )
}
