import { connectDatabase } from '../lib/database.ts'
import type { Database } from '../lib/database.ts'
import type { EmailMessage, EmailSender } from '../lib/email.ts'
import { createIdFactory } from '../lib/ids.ts'
import type { IdFactory } from '../lib/ids.ts'
import { createLogger } from '../lib/logger.ts'
import type { SecretEncryptionConfig } from '../lib/secrets.ts'
import { createEventBus } from '../runtime/events.ts'
import type { EventBus } from '../runtime/events.ts'
import type { ModuleServices } from '../runtime/module.ts'
import { createTransactionScope } from '../runtime/transaction.ts'

/**
 * The collaborators a module needs, wired for tests.
 *
 * Without a database the connection is still real, just never opened: postgres.js
 * connects lazily. A test that queries by accident fails on connect rather than
 * against a stub that quietly agrees with it.
 */

/** Never queried. A unit test that reaches the database fails here, loudly. */
const UNUSED_DATABASE_URL = 'postgres://unused:unused@127.0.0.1:1/unused'

export interface TestServicesOptions {
  readonly db?: Database
  readonly now?: () => Date
  readonly createId?: IdFactory
  readonly events?: EventBus
  /** Threaded through to `ModuleServices.appBaseUrl`, so a test exercises the preferred path. */
  readonly appBaseUrl?: string
  /** Threaded through to `ModuleServices.secretEncryption`, so a test exercises the preferred path. */
  readonly secretEncryption?: SecretEncryptionConfig
}

export interface TestServices extends ModuleServices {
  /** Everything the email port was asked to send, in order. */
  readonly sentEmails: readonly EmailMessage[]
  readonly events: EventBus
}

/** Collects messages instead of sending them, so a test can read the reset link. */
function createCollectingEmailSender(): { sender: EmailSender; sent: EmailMessage[] } {
  const sent: EmailMessage[] = []

  return {
    sent,
    sender: {
      send(message) {
        sent.push(message)

        return Promise.resolve()
      },
    },
  }
}

export function createTestServices(options: TestServicesOptions = {}): TestServices {
  const logger = createLogger({ level: 'error', transports: [] })
  const db = options.db ?? connectDatabase(UNUSED_DATABASE_URL, logger).db
  const events = options.events ?? createEventBus(logger)
  const createId = options.createId ?? createIdFactory()
  const now = options.now ?? ((): Date => new Date())
  const { sender, sent } = createCollectingEmailSender()

  return {
    db,
    transaction: createTransactionScope({ db, bus: events, logger, createId, now }),
    email: sender,
    createId,
    now,
    sentEmails: sent,
    events,
    // Spread conditionally so the field is absent (not `undefined`) when the
    // caller does not opt in, keeping the fallback path (context.config) live
    // for the many suites that never touch these fields.
    ...(options.appBaseUrl === undefined ? {} : { appBaseUrl: options.appBaseUrl }),
    ...(options.secretEncryption === undefined ? {} : { secretEncryption: options.secretEncryption }),
  }
}
