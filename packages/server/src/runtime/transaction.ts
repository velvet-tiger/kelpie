import type { EventActor, EventTarget, KelpieEvent } from '@kelpie/schemas'

import type { Database } from '../lib/database.ts'
import type { IdFactory } from '../lib/ids.ts'
import type { Logger } from '../lib/logger.ts'
import { checkEventCycle, currentEventChain } from './events.ts'
import type { EventBus, EventName, KelpieEventMap } from './events.ts'

/**
 * One service call, one transaction, per `architecture.md`.
 *
 * Events emitted inside the work are buffered and published only after the
 * transaction commits. A transaction that rolls back publishes nothing, so no
 * consumer ever sees a record that does not exist.
 */

/** The transaction handle Drizzle passes to the work. Repositories join it. */
export type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0]

/**
 * What a repository function runs against: the pool for a single read, or an open
 * transaction when a service is composing several writes.
 */
export type Queryable = Database | Transaction

type EventMapFor<Name extends EventName> = keyof KelpieEventMap extends never
  ? unknown
  : Name extends keyof KelpieEventMap
    ? KelpieEventMap[Name]
    : unknown

/**
 * Collects events during the transaction. Nothing leaves until commit.
 *
 * `emit` stamps the envelope (id, workspaceId, actor, occurredAt, causedBy) so
 * services pass only what they know: the name, the target the event refers to,
 * and the module-defined payload.
 */
export interface BufferedEvents {
  emit<Name extends EventName>(name: Name, target: EventTarget, data: EventMapFor<Name>): void
}

export interface TransactionContext {
  readonly tx: Transaction
  readonly events: BufferedEvents
}

export interface TransactionOptions {
  /**
   * The tenant this work belongs to. Every event emitted from the scope stamps
   * it into the envelope. Required when any event is emitted; a scope that
   * emits nothing may omit it.
   */
  readonly workspaceId?: string
  /** Who caused this work. Defaults to `system`. */
  readonly actor?: EventActor
}

/** Runs `work` in one transaction and publishes its events after commit. */
export type TransactionScope = <Result>(
  work: (context: TransactionContext) => Promise<Result>,
  options?: TransactionOptions,
) => Promise<Result>

interface BufferedEvent {
  readonly name: string
  readonly envelope: KelpieEvent<string, unknown>
}

const SYSTEM_ACTOR: EventActor = { kind: 'system' }

export interface TransactionScopeDependencies {
  readonly db: Database
  readonly bus: EventBus
  readonly logger: Logger
  readonly createId: IdFactory
  /** Injected so a test can pin timestamps. Defaults to `Date.now`. */
  readonly now?: () => Date
  /** Chain-depth cap. Reads `KELPIE_EVENT_MAX_DEPTH`; otherwise 8. */
  readonly maxDepth?: number
}

export function createTransactionScope(dependencies: TransactionScopeDependencies): TransactionScope {
  const now = dependencies.now ?? ((): Date => new Date())
  const maxDepth = dependencies.maxDepth ?? readMaxDepthFromEnv() ?? 8

  return async function runInTransaction(work, options) {
    const actor = options?.actor ?? SYSTEM_ACTOR
    const workspaceId = options?.workspaceId
    const buffered: BufferedEvent[] = []

    const result = await dependencies.db.transaction((tx) =>
      work({
        tx,
        events: {
          emit(name, target, data) {
            if (workspaceId === undefined || workspaceId.length === 0) {
              throw new Error(
                `event "${name}" was emitted without a workspaceId: pass it via TransactionOptions`,
              )
            }

            const chain = currentEventChain()
            const outcome = checkEventCycle(chain, name, target, maxDepth)

            if (outcome.kind !== 'ok') {
              dependencies.logger.error('event cycle guard dropped emit', {
                event: name,
                target,
                reason: outcome.kind,
                chain: chain.map((entry) => ({
                  id: entry.id,
                  name: entry.name,
                  target: { type: entry.targetType, id: entry.targetId },
                })),
              })
              return
            }

            const envelope: KelpieEvent<string, unknown> = {
              id: dependencies.createId('event'),
              name,
              workspaceId,
              actor,
              occurredAt: now().toISOString(),
              target,
              ...(chain.length > 0 ? { causedBy: chain[chain.length - 1]!.id } : {}),
              data: data as unknown,
            }

            buffered.push({ name, envelope })
          },
        },
      }),
    )

    // Past this line the transaction has committed. Publishing is deliberately
    // not awaited: an outbound HTTP delivery must not sit inside the request
    // that triggered it. Tests and graceful shutdown wait via `bus.drain()`.
    for (const event of buffered) {
      void dependencies.bus.publish(event.envelope as never).catch((error: unknown) => {
        dependencies.logger.error('event publication failed', { event: event.name, error })
      })
    }

    return result
  }
}

function readMaxDepthFromEnv(): number | undefined {
  const raw = process.env.KELPIE_EVENT_MAX_DEPTH
  if (raw === undefined || raw === '') {
    return undefined
  }
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined
}
