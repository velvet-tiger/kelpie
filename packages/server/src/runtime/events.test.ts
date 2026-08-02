import { describe, expect, it } from 'vitest'

import { createLogger } from '../lib/logger.ts'
import { DOMAIN_EVENT_NAMES, createEventBus } from './events.ts'

function silentBus(): ReturnType<typeof createEventBus> {
  return createEventBus(createLogger('error', () => undefined))
}

describe('createEventBus', () => {
  it('delivers a payload to every subscriber of that event', async () => {
    const bus = silentBus()
    const seen: string[] = []

    bus.subscribe('workspace.created', async (payload) => {
      seen.push(`first:${payload.slug}`)
    })
    bus.subscribe('workspace.created', async (payload) => {
      seen.push(`second:${payload.slug}`)
    })

    await bus.publish('workspace.created', { workspaceId: 'ws_1', slug: 'acme' })

    expect(seen.toSorted()).toEqual(['first:acme', 'second:acme'])
  })

  it('delivers nothing to subscribers of a different event', async () => {
    const bus = silentBus()
    let called = false

    bus.subscribe('member.joined', async () => {
      called = true
    })

    await bus.publish('workspace.created', { workspaceId: 'ws_1', slug: 'acme' })

    expect(called).toBe(false)
  })

  it('publishes to no subscribers without complaint', async () => {
    await expect(silentBus().publish('import.completed', {
      workspaceId: 'ws_1',
      importJobId: 'imp_1',
      object: 'people',
    })).resolves.toBeUndefined()
  })

  it('runs the remaining handlers when one throws, and logs it', async () => {
    const logLines: string[] = []
    const bus = createEventBus(createLogger('error', (line) => logLines.push(line)))
    let survivorRan = false

    bus.subscribe('note.added', () => Promise.reject(new Error('subscriber exploded')))
    bus.subscribe('note.added', async () => {
      survivorRan = true
    })

    await bus.publish('note.added', {
      workspaceId: 'ws_1',
      noteId: 'note_1',
      targetType: 'person',
      targetId: 'per_1',
    })

    expect(survivorRan).toBe(true)
    expect(logLines.join('\n')).toContain('subscriber exploded')
  })

  it('does not reject the publisher when a handler throws', async () => {
    const bus = silentBus()
    bus.subscribe('plan.completed', () => Promise.reject(new Error('nope')))

    await expect(
      bus.publish('plan.completed', {
        workspaceId: 'ws_1',
        planItemId: 'plan_1',
        targetType: 'deal',
        targetId: 'deal_1',
      }),
    ).resolves.toBeUndefined()
  })

  it('drains publications a handler started', async () => {
    const bus = silentBus()
    const order: string[] = []

    bus.subscribe('form.submitted', async (payload) => {
      order.push('form handled')
      void bus.publish('record.created', {
        workspaceId: payload.workspaceId,
        objectType: 'person',
        recordId: 'per_1',
      })
    })
    bus.subscribe('record.created', async () => {
      order.push('record handled')
    })

    void bus.publish('form.submitted', { workspaceId: 'ws_1', formId: 'form_1', submissionId: 'sub_1' })
    await bus.drain()

    expect(order).toEqual(['form handled', 'record handled'])
  })
})

describe('DOMAIN_EVENT_NAMES', () => {
  it('lists the catalog modules.md documents', () => {
    expect([...DOMAIN_EVENT_NAMES]).toEqual([
      'workspace.created',
      'member.invited',
      'member.joined',
      'record.created',
      'record.updated',
      'record.deleted',
      'stage.changed',
      'note.added',
      'decision.added',
      'plan.completed',
      'form.submitted',
      'import.completed',
      'agent_run.finished',
    ])
  })
})
