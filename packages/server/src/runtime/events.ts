import { describeThrown } from '../lib/errors.ts'
import type { Logger } from '../lib/logger.ts'

/**
 * In-process typed domain events, per `modules.md`.
 *
 * Delivery is at-least-once within the process, with no durable queue. A crash
 * between commit and dispatch loses the event. A durable outbox is a known
 * follow-up; do not build it before a consumer cannot tolerate the loss.
 */

/** CRM object types that `record.*` events carry. */
export const RECORD_OBJECT_TYPES = [
  'person',
  'company',
  'position',
  'deal',
  'opportunity',
  'partnership',
  'raise',
  'role',
  'candidate',
  'handbook_page',
  'form',
] as const

export type RecordObjectType = (typeof RECORD_OBJECT_TYPES)[number]

/** Objects whose stage or status moves through a pipeline. */
export type StagedObjectType = 'deal' | 'opportunity' | 'raise' | 'partnership'

/**
 * The event catalog. Every payload carries `workspaceId`: a consumer must never
 * have to look up which tenant an event belongs to.
 *
 * Adding an event means adding a key here. The name is the key, so a typo is a
 * compile error rather than a subscription that never fires.
 */
export interface DomainEvents {
  'workspace.created': { workspaceId: string; slug: string }
  'member.invited': { workspaceId: string; inviteId: string; email: string }
  'member.joined': { workspaceId: string; memberId: string; userId: string }
  'record.created': { workspaceId: string; objectType: RecordObjectType; recordId: string }
  'record.updated': {
    workspaceId: string
    objectType: RecordObjectType
    recordId: string
    changedFields: readonly string[]
  }
  'record.deleted': { workspaceId: string; objectType: RecordObjectType; recordId: string }
  'stage.changed': {
    workspaceId: string
    objectType: StagedObjectType
    recordId: string
    fromStageId: string | null
    toStageId: string
  }
  'note.added': { workspaceId: string; noteId: string; targetType: string; targetId: string }
  'decision.added': { workspaceId: string; decisionId: string; targetType: string; targetId: string }
  'plan.completed': { workspaceId: string; planItemId: string; targetType: string; targetId: string }
  'form.submitted': { workspaceId: string; formId: string; submissionId: string }
  'import.completed': { workspaceId: string; importJobId: string; object: string }
  'agent_run.finished': { workspaceId: string; agentRunId: string; status: 'succeeded' | 'failed' }
}

export type DomainEventName = keyof DomainEvents

/**
 * The catalog as data. Webhooks needs the deliverable event names at runtime, and
 * `satisfies` keeps this list from drifting from the interface above.
 *
 * An event added to `DomainEvents` but forgotten here is caught by
 * `createHandlerRegistry`, which must produce an entry for every name.
 */
export const DOMAIN_EVENT_NAMES = [
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
] as const satisfies readonly DomainEventName[]

/** Handlers are async and must be idempotent: the same event may arrive twice. */
export type EventHandler<Name extends DomainEventName> = (payload: DomainEvents[Name]) => Promise<void>

export interface EventBus {
  /** Registers a handler. Handlers for one event run concurrently, not in order. */
  subscribe<Name extends DomainEventName>(name: Name, handler: EventHandler<Name>): void
  /**
   * Dispatches immediately. Services should not call this directly: they emit
   * through the transaction scope so nothing fires before the commit.
   *
   * @returns A promise that settles when every handler for this event has settled.
   */
  publish<Name extends DomainEventName>(name: Name, payload: DomainEvents[Name]): Promise<void>
  /**
   * Settles once every in-flight publication has finished, including any a
   * handler started. Used by tests, and by shutdown to flush before exit.
   */
  drain(): Promise<void>
}

/**
 * A handler that throws must not break the emitting request, and must not stop
 * its siblings. Failures are logged and dropped.
 */
/** One handler list per event, keyed so each list stays tied to its payload type. */
type HandlerRegistry = { [Name in DomainEventName]: EventHandler<Name>[] }

/**
 * Every name gets a list up front. TypeScript cannot check a write through a
 * generic key, so pre-seeding turns `subscribe` into a read plus a push, which it
 * can check. The one assertion is building a complete record from its own key list.
 */
function createHandlerRegistry(): HandlerRegistry {
  const registry: Partial<HandlerRegistry> = {}

  for (const name of DOMAIN_EVENT_NAMES) {
    registry[name] = []
  }

  return registry as HandlerRegistry
}

export function createEventBus(logger: Logger): EventBus {
  const handlers = createHandlerRegistry()
  const inFlight = new Set<Promise<void>>()

  return {
    subscribe(name, handler) {
      handlers[name].push(handler)
    },

    publish(name, payload) {
      const registered = handlers[name]

      const settled = Promise.allSettled(registered.map((handler) => handler(payload))).then(
        (outcomes) => {
          for (const outcome of outcomes) {
            if (outcome.status === 'rejected') {
              logger.error('event handler failed', {
                event: name,
                error: describeThrown(outcome.reason),
              })
            }
          }
        },
      )

      inFlight.add(settled)
      void settled.finally(() => inFlight.delete(settled))

      return settled
    },

    async drain() {
      // A handler may publish further events, so keep draining until the set is
      // empty rather than awaiting one snapshot of it.
      while (inFlight.size > 0) {
        await Promise.allSettled([...inFlight])
      }
    },
  }
}
