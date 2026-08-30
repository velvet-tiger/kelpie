import type { KelpieEvent } from '@kelpie/schemas'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import { createLogger } from '../../lib/logger.ts'
import { createEventBus } from '../../runtime/events.ts'
import type { EventBus } from '../../runtime/events.ts'
import { subscribeDeliverableEvents, translateEnvelopeEvent } from './payloads.ts'
import type { WebhookEventPayload } from './payloads.ts'

/**
 * The bridge fans two subscribe paths in during the migration to per-module
 * event catalogs, and both must resolve to the same wire payload. These tests
 * pin the translation from envelope names to `record.*` / `form.submitted`
 * bodies, so a service can switch to `emitEvent` without a webhook receiver
 * seeing the change.
 */

function silentBus(): EventBus {
  return createEventBus(createLogger({ level: 'error', transports: [] }))
}

function envelope<Data>(
  name: string,
  target: { readonly type: string; readonly id: string },
  data: Data,
  overrides: { readonly workspaceId?: string } = {},
): KelpieEvent<string, Data> {
  return {
    id: `ev_${name}_${target.id}`,
    name,
    workspaceId: overrides.workspaceId ?? 'ws_1',
    actor: { kind: 'system' },
    occurredAt: '2026-08-21T00:00:00.000Z',
    target,
    data,
  }
}

describe('translateEnvelopeEvent', () => {
  it('maps a per-object created event to record.created', () => {
    const result = translateEnvelopeEvent(
      envelope('people.person.created', { type: 'person', id: 'per_1' }, {}),
    )

    expect(result).toEqual({
      workspaceId: 'ws_1',
      event: 'record.created',
      data: { object_type: 'person', record_id: 'per_1' },
    })
  })

  it('maps a per-object updated event to record.updated with changed_fields', () => {
    const result = translateEnvelopeEvent(
      envelope(
        'deals.deal.updated',
        { type: 'deal', id: 'deal_1' },
        { changed: ['stage', 'amount'] },
      ),
    )

    expect(result).toEqual({
      workspaceId: 'ws_1',
      event: 'record.updated',
      data: { object_type: 'deal', record_id: 'deal_1', changed_fields: ['stage', 'amount'] },
    })
  })

  it('defaults changed_fields to an empty array when the envelope carries no changed key', () => {
    const result = translateEnvelopeEvent(
      envelope('companies.company.updated', { type: 'company', id: 'com_1' }, {}),
    )

    expect(result?.data).toMatchObject({ changed_fields: [] })
  })

  it('maps a per-object deleted event to record.deleted', () => {
    const result = translateEnvelopeEvent(
      envelope('people.person.deleted', { type: 'person', id: 'per_2' }, {}),
    )

    expect(result).toEqual({
      workspaceId: 'ws_1',
      event: 'record.deleted',
      data: { object_type: 'person', record_id: 'per_2' },
    })
  })

  it('drops an envelope whose target is not a CRM record object', () => {
    expect(
      translateEnvelopeEvent(
        envelope('workspace.workspace.created', { type: 'workspace', id: 'ws_1' }, {}),
      ),
    ).toBeUndefined()
    expect(
      translateEnvelopeEvent(envelope('notes.note.added', { type: 'note', id: 'note_1' }, {})),
    ).toBeUndefined()
  })

  it('maps a form submission envelope to form.submitted when both ids are present', () => {
    const result = translateEnvelopeEvent(
      envelope(
        'forms.submission.submitted',
        { type: 'submission', id: 'sub_1' },
        {
          formId: 'form_1',
          submissionId: 'sub_1',
          opportunityId: null,
          partnershipId: null,
          actions: [],
        },
      ),
    )

    expect(result).toEqual({
      workspaceId: 'ws_1',
      event: 'form.submitted',
      data: {
        form_id: 'form_1',
        submission_id: 'sub_1',
        opportunity_id: null,
        partnership_id: null,
        enquiry_id: null,
        actions: [],
      },
    })
  })

  it('carries the post-submit ids and per-action statuses through', () => {
    const result = translateEnvelopeEvent(
      envelope(
        'forms.submission.submitted',
        { type: 'submission', id: 'sub_2' },
        {
          formId: 'form_2',
          submissionId: 'sub_2',
          opportunityId: 'opp_1',
          partnershipId: 'prt_1',
          actions: [
            { action: 'create_deal', status: 'ok' },
            { action: 'tag_company', status: 'skipped' },
          ],
        },
      ),
    )

    expect(result).toEqual({
      workspaceId: 'ws_1',
      event: 'form.submitted',
      data: {
        form_id: 'form_2',
        submission_id: 'sub_2',
        opportunity_id: 'opp_1',
        partnership_id: 'prt_1',
        enquiry_id: null,
        actions: [
          { action: 'create_deal', status: 'ok' },
          { action: 'tag_company', status: 'skipped' },
        ],
      },
    })
  })

  it('drops an envelope whose verb is not deliverable', () => {
    expect(
      translateEnvelopeEvent(
        envelope('deals.deal.stage_changed', { type: 'deal', id: 'deal_1' }, {}),
      ),
    ).toBeUndefined()
  })
})

describe('subscribeDeliverableEvents', () => {
  it('delivers a per-object created envelope through the prefix bridge', async () => {
    const bus = silentBus()
    const delivered: WebhookEventPayload[] = []

    bus.registerCatalog({
      moduleId: 'people',
      events: { 'people.person.created': z.object({}).strict() },
    })
    subscribeDeliverableEvents(bus, async (payload) => {
      delivered.push(payload)
    })

    await bus.publish(
      envelope('people.person.created', { type: 'person', id: 'per_1' }, {}) as never,
    )
    await bus.drain()

    expect(delivered).toEqual([
      {
        workspaceId: 'ws_1',
        event: 'record.created',
        data: { object_type: 'person', record_id: 'per_1' },
      },
    ])
  })

  it('delivers one payload per emitted envelope with no duplicates', async () => {
    const bus = silentBus()
    const delivered: WebhookEventPayload[] = []

    subscribeDeliverableEvents(bus, async (payload) => {
      delivered.push(payload)
    })

    await bus.publish(
      envelope('companies.company.deleted', { type: 'company', id: 'com_1' }, {}) as never,
    )
    await bus.publish(
      envelope('deals.deal.deleted', { type: 'deal', id: 'deal_1' }, {}) as never,
    )
    await bus.drain()

    expect(delivered).toHaveLength(2)
    expect(delivered.map((entry) => entry.data.record_id)).toEqual(['com_1', 'deal_1'])
  })
})
