import type { WebhookEvent, WebhookSettableStatus, WebhookStatus } from '@kelpie/schemas'

import { changedKeys } from '../../lib/changes.ts'
import type { Database } from '../../lib/database.ts'
import { AppError } from '../../lib/errors.ts'
import type { IdFactory } from '../../lib/ids.ts'
import { mapPage, readListWindow, toPage } from '../../lib/pagination.ts'
import type { ListQueryParameters, Page } from '../../lib/pagination.ts'
import type { SecretCipher } from '../../lib/secrets.ts'
import { generateToken } from '../../lib/tokens.ts'
import type { TransactionScope } from '../../runtime/transaction.ts'
import type { Actor } from '../auth/actor.ts'
import { requireWorkspaceId } from '../auth/actor.ts'
import { roleAllows } from '../workspace/roles.ts'
import * as repository from './repository.ts'
import {
  DEFAULT_DELIVERY_SORT,
  DEFAULT_WEBHOOK_SORT,
  DELIVERY_SORTS,
  WEBHOOK_SORTS,
} from './repository.ts'
import type {
  DeliveryFilters,
  DeliveryRecord,
  WebhookFilters,
  WebhookRecord,
} from './repository.ts'

/**
 * Webhook registration.
 *
 * Every verb needs the admin role, including the reads. A webhook URL routinely
 * carries its own credential in the path — `hooks.slack.com/services/T…/B…/…`
 * is the common case — so listing registrations is disclosing a secret, not
 * describing a setting. That puts this alongside API keys rather than alongside
 * the team list any member may read.
 */

/** `whsec_` is what a leak scanner greps for, so it lives in the secret itself. */
const SECRET_PREFIX = 'whsec_'

export interface WebhooksDependencies {
  readonly db: Database
  readonly transaction: TransactionScope
  readonly createId: IdFactory
  readonly now: () => Date
  readonly cipher: SecretCipher
  /** Injected only so tests can pin secrets. Production uses the crypto default. */
  readonly newToken?: () => string
}

/** A webhook as the API returns one: never the secret, never the tenancy column. */
export interface WebhookView {
  readonly id: string
  readonly url: string
  readonly events: readonly WebhookEvent[]
  readonly secretPrefix: string
  readonly status: WebhookStatus
  readonly lastDeliveryAt: Date | null
  readonly lastDeliveryStatus: DeliveryRecord['status'] | null
  readonly createdAt: Date
  readonly updatedAt: Date
}

/** The one response that carries the signing secret. Nothing retrieves it later. */
export interface CreatedWebhookView extends WebhookView {
  readonly secret: string
}

export type DeliveryView = Omit<DeliveryRecord, 'workspaceId'>

export interface CreateWebhookInput {
  readonly url: string
  readonly events: readonly WebhookEvent[]
}

export interface UpdateWebhookInput {
  readonly url?: string | undefined
  readonly events?: readonly WebhookEvent[] | undefined
  readonly status?: WebhookSettableStatus | undefined
}

export interface WebhooksService {
  list(actor: Actor, filters: WebhookFilters, query: ListQueryParameters): Promise<Page<WebhookView>>
  get(actor: Actor, id: string): Promise<WebhookView>
  create(actor: Actor, input: CreateWebhookInput): Promise<CreatedWebhookView>
  update(actor: Actor, id: string, changes: UpdateWebhookInput): Promise<WebhookView>
  remove(actor: Actor, id: string): Promise<void>
  listDeliveries(
    actor: Actor,
    webhookId: string,
    filters: DeliveryFilters,
    query: ListQueryParameters,
  ): Promise<Page<DeliveryView>>
}

/**
 * Mints a signing secret and the prefix stored beside it.
 *
 * The prefix shows the trailing characters rather than the leading ones, the
 * same shape an API key's `display_prefix` has: two registrations are told
 * apart by their ends, and the start of every secret is identical anyway.
 */
function mintSecret(randomToken: () => string): { secret: string; secretPrefix: string } {
  const secret = `${SECRET_PREFIX}${randomToken()}`

  return { secret, secretPrefix: `${SECRET_PREFIX}…${secret.slice(-4)}` }
}

export function createWebhooksService(dependencies: WebhooksDependencies): WebhooksService {
  const newToken = dependencies.newToken ?? generateToken

  /**
   * Reads the role off the actor rather than re-querying the membership.
   * `credentials.ts` resolves it from the live `workspace_members` row on every
   * request, so it is already as fresh as a query here would be.
   */
  function requireAdmin(actor: Actor): void {
    if (actor.role === null || !roleAllows(actor.role, 'admin')) {
      throw new AppError('forbidden', 'This action needs the admin role')
    }
  }

  /** The workspace this actor administers, or a refusal. */
  function requireAdminWorkspace(actor: Actor): string {
    const workspaceId = requireWorkspaceId(actor)

    requireAdmin(actor)

    return workspaceId
  }

  async function require(workspaceId: string, id: string): Promise<WebhookRecord> {
    const webhook = await repository.findWebhook(dependencies.db, workspaceId, id)

    // A webhook in another workspace is indistinguishable from one that never
    // existed, per `api.md`.
    if (webhook === undefined) {
      throw AppError.notFound('Webhook not found')
    }

    return webhook
  }

  async function toViews(records: readonly WebhookRecord[]): Promise<WebhookView[]> {
    const lastDeliveries = await repository.findLastDeliveries(
      dependencies.db,
      records.map((record) => record.id),
    )

    return records.map((record) => {
      const last = lastDeliveries.get(record.id)

      return {
        id: record.id,
        url: record.url,
        events: record.events,
        secretPrefix: record.secretPrefix,
        status: record.status,
        lastDeliveryAt: last?.at ?? null,
        lastDeliveryStatus: last?.status ?? null,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
      }
    })
  }

  async function toView(record: WebhookRecord): Promise<WebhookView> {
    const [view] = await toViews([record])

    if (view === undefined) {
      throw new Error(`Rendering webhook ${record.id} produced no view`)
    }

    return view
  }

  function toDeliveryView(record: DeliveryRecord): DeliveryView {
    const { workspaceId: _workspaceId, ...view } = record

    return view
  }

  return {
    async list(actor, filters, query) {
      const workspaceId = requireAdminWorkspace(actor)
      const window = readListWindow(query, WEBHOOK_SORTS, DEFAULT_WEBHOOK_SORT)
      const rows = await repository.listWebhooks(dependencies.db, workspaceId, filters, window)
      const page = toPage(rows, window, (webhook) => webhook.id)

      return { items: await toViews(page.items), nextCursor: page.nextCursor }
    },

    async get(actor, id) {
      return toView(await require(requireAdminWorkspace(actor), id))
    },

    async create(actor, input) {
      const workspaceId = requireAdminWorkspace(actor)
      const { secret, secretPrefix } = mintSecret(newToken)
      const id = dependencies.createId('webhook')

      const created = await dependencies.transaction(({ tx }) =>
        repository.insertWebhook(tx, {
          id,
          workspaceId,
          url: input.url,
          events: [...input.events],
          secretEncrypted: dependencies.cipher.seal(secret),
          secretPrefix,
          status: 'active',
        }),
      )

      // The only time the secret leaves this process. Nothing stores it.
      return { ...(await toView(created)), secret }
    },

    async update(actor, id, changes) {
      const workspaceId = requireAdminWorkspace(actor)
      const existing = await require(workspaceId, id)

      const columns: Partial<repository.WebhookColumns> = {
        ...(changes.url === undefined ? {} : { url: changes.url }),
        ...(changes.events === undefined ? {} : { events: [...changes.events] }),
        ...(changes.status === undefined ? {} : { status: changes.status }),
      }

      // A PATCH that changes nothing is not a write. Bumping `updated_at` for
      // it would make the registration look freshly touched, and that field is
      // what a customer reads against `last_delivery_at` to tell whether a fix
      // has been tried yet.
      if (changedKeys(existing, columns).length === 0) {
        return toView(existing)
      }

      const updated = await dependencies.transaction(async ({ tx }) => {
        const row = await repository.updateWebhook(tx, workspaceId, id, {
          ...columns,
          updatedAt: dependencies.now(),
        })

        if (row === undefined) {
          throw AppError.notFound('Webhook not found')
        }

        return row
      })

      return toView(updated)
    },

    async remove(actor, id) {
      const workspaceId = requireAdminWorkspace(actor)

      // No event of its own. The catalog has nothing for a webhook changing,
      // and a hook that has just been deleted cannot be told about it anyway.
      await dependencies.transaction(async ({ tx }) => {
        await require(workspaceId, id)
        await repository.deleteWebhook(tx, workspaceId, id)
      })
    },

    async listDeliveries(actor, webhookId, filters, query) {
      const workspaceId = requireAdminWorkspace(actor)

      // Unlike a filtered CRM list, a missing parent here is a 404 rather than
      // an empty page: the path names the webhook, so there is no list to be
      // empty if it does not exist.
      await require(workspaceId, webhookId)

      const window = readListWindow(query, DELIVERY_SORTS, DEFAULT_DELIVERY_SORT)
      const rows = await repository.listDeliveries(
        dependencies.db,
        workspaceId,
        webhookId,
        filters,
        window,
      )

      return mapPage(
        toPage(rows, window, (delivery) => delivery.id),
        toDeliveryView,
      )
    },
  }
}
