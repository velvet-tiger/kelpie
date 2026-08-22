import type { KelpieEvent } from '@kelpie/schemas'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import { createLogger } from '../lib/logger.ts'
import { checkEventCycle, createEventBus } from './events.ts'

function silentBus(): ReturnType<typeof createEventBus> {
  return createEventBus(createLogger('error', () => undefined))
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

describe('createEventBus catalog', () => {
  it('registers a catalog and answers hasEvent / getSchema', () => {
    const bus = silentBus()
    const schema = z.object({ personId: z.string() })

    bus.registerCatalog({ moduleId: 'people', events: { 'people.person.created': schema } })

    expect(bus.hasEvent('people.person.created')).toBe(true)
    expect(bus.getSchema('people.person.created')).toBe(schema)
    expect(bus.hasEvent('people.person.deleted')).toBe(false)
  })

  it('rejects a duplicate event name declared by two modules', () => {
    const bus = silentBus()
    bus.registerCatalog({ moduleId: 'people', events: { 'people.person.created': z.object({}) } })

    expect(() =>
      bus.registerCatalog({ moduleId: 'shadow', events: { 'people.person.created': z.object({}) } }),
    ).toThrow(/declared by both module "people" and module "shadow"/)
  })
})

describe('createEventBus publish', () => {
  it('delivers an envelope to subscribers of that exact name', async () => {
    const bus = silentBus()
    const received: KelpieEvent<string, unknown>[] = []

    bus.subscribe('people.person.created' as never, (event) => {
      received.push(event as KelpieEvent<string, unknown>)
    })

    await bus.publish(
      envelope('people.person.created', { type: 'person', id: 'per_1' }, {}) as never,
    )

    expect(received).toHaveLength(1)
    expect(received[0]?.target.id).toBe('per_1')
  })

  it('delivers to a prefix subscriber and skips non-matching prefixes', async () => {
    const bus = silentBus()
    const seen: string[] = []

    bus.subscribePrefix('people.', (event) => {
      seen.push(event.name)
    })
    bus.subscribePrefix('deals.', (event) => {
      seen.push(`deal:${event.name}`)
    })

    await bus.publish(
      envelope('people.person.created', { type: 'person', id: 'per_1' }, {}) as never,
    )

    expect(seen).toEqual(['people.person.created'])
  })

  it('publishes to no subscribers without complaint', async () => {
    await expect(
      silentBus().publish(
        envelope('nothing.happens', { type: 'person', id: 'per_1' }, {}) as never,
      ),
    ).resolves.toBeUndefined()
  })

  it('runs the remaining handlers when one throws, and logs it', async () => {
    const logLines: string[] = []
    const bus = createEventBus(createLogger('error', (line) => logLines.push(line)))
    let survivorRan = false

    bus.subscribe('people.person.created' as never, () =>
      Promise.reject(new Error('subscriber exploded')),
    )
    bus.subscribe('people.person.created' as never, () => {
      survivorRan = true
    })

    await bus.publish(
      envelope('people.person.created', { type: 'person', id: 'per_1' }, {}) as never,
    )

    expect(survivorRan).toBe(true)
    expect(logLines.join('\n')).toContain('subscriber exploded')
  })

  it('does not reject the publisher when a handler throws', async () => {
    const bus = silentBus()
    bus.subscribe('people.person.deleted' as never, () => Promise.reject(new Error('nope')))

    await expect(
      bus.publish(envelope('people.person.deleted', { type: 'person', id: 'per_1' }, {}) as never),
    ).resolves.toBeUndefined()
  })

  it('drains publications a handler started', async () => {
    const bus = silentBus()
    const order: string[] = []

    bus.subscribe('forms.submission.submitted' as never, async (event) => {
      order.push('form handled')
      void bus.publish(
        envelope(
          'people.person.created',
          { type: 'person', id: 'per_1' },
          {},
          { workspaceId: event.workspaceId },
        ) as never,
      )
    })
    bus.subscribe('people.person.created' as never, () => {
      order.push('record handled')
    })

    void bus.publish(
      envelope(
        'forms.submission.submitted',
        { type: 'submission', id: 'sub_1' },
        { formId: 'form_1', submissionId: 'sub_1' },
      ) as never,
    )
    await bus.drain()

    expect(order).toEqual(['form handled', 'record handled'])
  })

  it('logs when a subscribed handler exceeds its timeout', async () => {
    const lines: string[] = []
    const bus = createEventBus(createLogger('error', (line) => lines.push(line)), {
      defaultHandlerTimeoutMs: 5,
    })

    bus.subscribe('people.person.created' as never, async () => {
      await new Promise((resolve) => setTimeout(resolve, 40))
    })

    await bus.publish(
      envelope('people.person.created', { type: 'person', id: 'per_1' }, {}) as never,
    )
    await bus.drain()

    expect(lines.some((line) => line.includes('event handler timed out'))).toBe(true)
  })
})

describe('checkEventCycle', () => {
  const target = { type: 'person', id: 'per_1' }

  it('accepts a fresh emit', () => {
    expect(checkEventCycle([], 'people.person.created', target, 8)).toEqual({ kind: 'ok' })
  })

  it('rejects an emit that exceeds the depth cap', () => {
    const chain = Array.from({ length: 8 }, (_, index) => ({
      id: `ev_${index}`,
      name: 'people.person.created',
      targetType: 'person',
      targetId: `per_${index}`,
    }))

    expect(checkEventCycle(chain, 'people.person.updated', target, 8)).toEqual({ kind: 'depth' })
  })

  it('rejects an emit that repeats a (name, target) triple in the chain', () => {
    const chain = [
      {
        id: 'ev_a',
        name: 'people.person.updated',
        targetType: 'person',
        targetId: 'per_1',
      },
    ]

    expect(checkEventCycle(chain, 'people.person.updated', target, 8)).toEqual({ kind: 'repeat' })
  })
})
