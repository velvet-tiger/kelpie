import type { Database } from '../lib/database.ts'
import type { Logger } from '../lib/logger.ts'
import type { DomainEventName, DomainEvents, EventBus } from './events.ts'

/**
 * One service call, one transaction, per `architecture.md`.
 *
 * Events emitted inside the work are buffered and published only after the
 * transaction commits. A transaction that rolls back publishes nothing, so no
 * consumer ever sees a record that does not exist.
 */

/** The transaction handle Drizzle passes to the work. Repositories join it. */
export type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0]

/** Collects events during the transaction. Nothing leaves until commit. */
export interface BufferedEvents {
  emit<Name extends DomainEventName>(name: Name, payload: DomainEvents[Name]): void
}

export interface TransactionContext {
  readonly tx: Transaction
  readonly events: BufferedEvents
}

/** Runs `work` in one transaction and publishes its events after commit. */
export type TransactionScope = <Result>(
  work: (context: TransactionContext) => Promise<Result>,
) => Promise<Result>

/**
 * A buffered event keeps its publication as a closure. The name and payload were
 * correlated at the `emit` call site; storing them as a pair would lose that and
 * force a cast at publication.
 */
interface BufferedEvent {
  readonly name: DomainEventName
  readonly publish: () => Promise<void>
}

export interface TransactionScopeDependencies {
  readonly db: Database
  readonly bus: EventBus
  readonly logger: Logger
}

export function createTransactionScope(dependencies: TransactionScopeDependencies): TransactionScope {
  return async function runInTransaction(work) {
    const buffered: BufferedEvent[] = []

    const result = await dependencies.db.transaction((tx) =>
      work({
        tx,
        events: {
          emit(name, payload) {
            buffered.push({ name, publish: () => dependencies.bus.publish(name, payload) })
          },
        },
      }),
    )

    // Past this line the transaction has committed. Publishing is deliberately
    // not awaited: the webhooks engine is a consumer, and an outbound HTTP
    // delivery must not sit inside the request that triggered it. Tests and
    // graceful shutdown wait via `bus.drain()`.
    for (const event of buffered) {
      void event.publish().catch((error: unknown) => {
        dependencies.logger.error('event publication failed', { event: event.name, error })
      })
    }

    return result
  }
}
