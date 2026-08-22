import { AsyncLocalStorage } from 'node:async_hooks'

import type { EventTarget, KelpieEvent } from '@kelpie/schemas'
import Emittery from 'emittery'
import type { ZodType } from 'zod'

import { describeThrown } from '../lib/errors.ts'
import type { Logger } from '../lib/logger.ts'

/**
 * In-process typed domain events, per `modules.md`.
 *
 * Delivery is at-least-once within the process, with no durable queue. A crash
 * between commit and dispatch loses the event. A durable outbox is a known
 * follow-up; do not build it before a consumer cannot tolerate the loss.
 *
 * Every event carries the envelope defined in `@kelpie/schemas`
 * (`KelpieEvent<Name, Data>`). Names and payload schemas live in per-module
 * catalogs the bus registers at boot; two modules cannot declare the same name.
 */

/**
 * CRM object types the webhooks bridge treats as deliverable records. Kept
 * here (rather than folded into a module) because import and webhooks both
 * read it, and neither owns the list.
 */
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

/**
 * The compile-time event catalog.
 *
 * Modules extend this interface via TypeScript declaration merging, one
 * declaration per module. The runtime catalog (see `registerCatalog`) is the
 * authority; this interface is what gives autocomplete and payload typing at
 * every `publish` and `subscribe` call site.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface KelpieEventMap {}

/**
 * When `KelpieEventMap` is empty (no module has declared an event yet) `keyof`
 * is `never`, which would make every `EventHandler` signature unusable. The
 * fallback keeps types working during boot and in tests that build the bus
 * without any modules registered.
 */
type EventMapWithFallback = keyof KelpieEventMap extends never
  ? Readonly<Record<string, unknown>>
  : KelpieEventMap

export type EventName = string & keyof EventMapWithFallback

/** Handlers are async and must be idempotent: the same event may arrive twice. */
export type EventHandler<Name extends EventName> = (
  event: KelpieEvent<Name, EventMapWithFallback[Name]>,
) => Promise<void> | void

/** Prefix subscribers see events they cannot name statically. */
export type AnyEventHandler = (event: KelpieEvent<string, unknown>) => Promise<void> | void

/**
 * What a module hands the runtime at registration: the module's id and the Zod
 * schema for every event name the module publishes.
 */
export interface EventCatalog {
  readonly moduleId: string
  readonly events: Readonly<Record<string, ZodType>>
}

/** One frame in the causation chain that produced an event. */
export interface EventChainEntry {
  readonly id: string
  readonly name: string
  readonly targetType: string
  readonly targetId: string
}

/**
 * The chain of ancestor events currently being handled, keyed against the async
 * context that started them. `undefined` outside any handler.
 *
 * The bus wraps every `publish` in `run(child, ...)`, so a handler that opens a
 * transaction and calls `emit(...)` inherits the chain. The transaction scope
 * reads this to stamp `causedBy` and to run the cycle guard.
 */
const chainStorage = new AsyncLocalStorage<readonly EventChainEntry[]>()

export function currentEventChain(): readonly EventChainEntry[] {
  return chainStorage.getStore() ?? []
}

/**
 * Runs the cycle guard against the current chain. Called from the transaction
 * scope's `emit` before it buffers the event.
 */
export function checkEventCycle(
  chain: readonly EventChainEntry[],
  name: string,
  target: EventTarget,
  maxDepth: number,
): CycleGuardOutcome {
  if (chain.length >= maxDepth) {
    return { kind: 'depth' }
  }
  for (const entry of chain) {
    if (entry.name === name && entry.targetType === target.type && entry.targetId === target.id) {
      return { kind: 'repeat' }
    }
  }
  return { kind: 'ok' }
}

export type CycleGuardOutcome =
  | { readonly kind: 'ok' }
  | { readonly kind: 'depth' }
  | { readonly kind: 'repeat' }

export interface SubscribeOptions {
  /** Shown in logs when the handler fails or times out. Defaults to the event name. */
  readonly label?: string
  /** Overrides the bus-wide default. */
  readonly timeoutMs?: number
}

export interface EventBus {
  /**
   * Registers a module's event catalog. Called by `registerModules` at boot,
   * once per module that declares events. Two modules cannot declare the same
   * event name; the second call throws.
   */
  registerCatalog(catalog: EventCatalog): void
  /** True if any module has declared this event name. */
  hasEvent(name: string): boolean
  /** The payload schema registered for this event, or `undefined` if unknown. */
  getSchema(name: string): ZodType | undefined
  /**
   * Subscribe to an event by exact name. Handlers for one event run
   * concurrently, each in its own error and timeout boundary.
   */
  subscribe<Name extends EventName>(
    name: Name,
    handler: EventHandler<Name>,
    options?: SubscribeOptions,
  ): void
  /**
   * Subscribe to every event whose name starts with `prefix`. Runs concurrently
   * with exact-name subscribers. Match is a plain `startsWith`; there is no
   * pattern language.
   */
  subscribePrefix(prefix: string, handler: AnyEventHandler, options?: SubscribeOptions): void
  /**
   * Dispatches immediately. Services should not call this directly: they emit
   * through the transaction scope so nothing fires before the commit.
   */
  publish<Name extends EventName>(
    event: KelpieEvent<Name, EventMapWithFallback[Name]>,
  ): Promise<void>
  /**
   * Settles once every in-flight publication has finished, including any a
   * handler started. Used by tests, and by shutdown to flush before exit.
   */
  drain(): Promise<void>
}

export interface EventBusOptions {
  /** Default per-handler timeout in ms. Defaults to 5000. */
  readonly defaultHandlerTimeoutMs?: number
}

const DEFAULT_HANDLER_TIMEOUT_MS = 5000

interface PrefixHandler {
  readonly prefix: string
  readonly label: string
  readonly run: (event: KelpieEvent<string, unknown>) => Promise<void>
}

/**
 * Emittery v2 passes each listener an `{ name, data }` object rather than the
 * raw payload. This shape stays internal so nothing outside this file sees the
 * extra envelope on top of ours.
 */
interface EmitteryListenerEvent {
  readonly name: string
  readonly data: unknown
}

interface EmitterySignature {
  readonly on: (
    name: string,
    listener: (event: EmitteryListenerEvent) => Promise<void> | void,
  ) => () => void
  readonly emit: (name: string, data: unknown) => Promise<void>
}

export function createEventBus(logger: Logger, options: EventBusOptions = {}): EventBus {
  const emittery = new Emittery() as unknown as EmitterySignature
  const schemas = new Map<string, ZodType>()
  const owners = new Map<string, string>()
  const prefixHandlers: PrefixHandler[] = []
  const inFlight = new Set<Promise<unknown>>()
  const defaultTimeoutMs = options.defaultHandlerTimeoutMs ?? DEFAULT_HANDLER_TIMEOUT_MS

  function wrap<Value>(
    label: string,
    timeoutMs: number,
    handler: (event: Value) => Promise<void> | void,
    context: (event: Value) => Readonly<Record<string, unknown>>,
  ): (event: Value) => Promise<void> {
    return async (event) => {
      let timerHandle: NodeJS.Timeout | undefined
      const timedOut = Symbol('timeout')
      const timer = new Promise<typeof timedOut>((resolve) => {
        timerHandle = setTimeout(() => resolve(timedOut), timeoutMs)
        timerHandle.unref?.()
      })

      try {
        const outcome = await Promise.race([
          Promise.resolve().then(() => handler(event)),
          timer,
        ])
        if (outcome === timedOut) {
          logger.error('event handler timed out', { label, timeoutMs, ...context(event) })
        }
      } catch (error: unknown) {
        logger.error('event handler failed', {
          label,
          error: describeThrown(error),
          ...context(event),
        })
      } finally {
        if (timerHandle !== undefined) {
          clearTimeout(timerHandle)
        }
      }
    }
  }

  return {
    registerCatalog(catalog) {
      for (const [name, schema] of Object.entries(catalog.events)) {
        const existing = owners.get(name)
        if (existing !== undefined) {
          throw new Error(
            `event "${name}" is declared by both module "${existing}" and module "${catalog.moduleId}"`,
          )
        }
        owners.set(name, catalog.moduleId)
        schemas.set(name, schema)
      }
    },

    hasEvent(name) {
      return schemas.has(name)
    },

    getSchema(name) {
      return schemas.get(name)
    },

    subscribe(name, handler, subscribeOptions) {
      const label = subscribeOptions?.label ?? name
      const timeoutMs = subscribeOptions?.timeoutMs ?? defaultTimeoutMs
      const wrapped = wrap<EmitteryListenerEvent>(
        label,
        timeoutMs,
        (event) => {
          const envelope = event.data as KelpieEvent<string, unknown>
          return handler(envelope as never)
        },
        (event) => {
          const envelope = event.data as KelpieEvent<string, unknown>
          return { event: envelope.name, eventId: envelope.id }
        },
      )
      emittery.on(name, wrapped)
    },

    subscribePrefix(prefix, handler, subscribeOptions) {
      const label = subscribeOptions?.label ?? `${prefix}*`
      const timeoutMs = subscribeOptions?.timeoutMs ?? defaultTimeoutMs
      prefixHandlers.push({
        prefix,
        label,
        run: wrap<KelpieEvent<string, unknown>>(
          label,
          timeoutMs,
          handler,
          (event) => ({ event: event.name, eventId: event.id }),
        ),
      })
    },

    publish(event) {
      const parent = chainStorage.getStore() ?? []
      const child: EventChainEntry[] = [
        ...parent,
        {
          id: event.id,
          name: event.name,
          targetType: event.target.type,
          targetId: event.target.id,
        },
      ]

      const matching = prefixHandlers.filter((entry) => event.name.startsWith(entry.prefix))
      const typedEvent = event as KelpieEvent<string, unknown>

      const settled = chainStorage.run(child, () =>
        Promise.allSettled([
          emittery.emit(event.name, typedEvent),
          ...matching.map((entry) => entry.run(typedEvent)),
        ]),
      )

      inFlight.add(settled)
      void settled.finally(() => {
        inFlight.delete(settled)
      })

      return settled.then(() => undefined)
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
