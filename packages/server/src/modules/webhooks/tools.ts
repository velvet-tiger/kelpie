import { WEBHOOK_DELIVERY_STATUSES, WEBHOOK_STATUSES } from '@kelpie/schemas'
import { z } from 'zod'

import type { McpToolRegistry } from '../../runtime/module.ts'
import { deleteResult, idArg, listWindowShape, pageResult, toListQuery } from '../crudTools.ts'
import {
  createBody,
  createdWebhookResponse,
  deliveryResponse,
  rotateBody,
  updateBody,
  webhookResponse,
} from './routes.ts'
import type { WebhooksService } from './service.ts'

/**
 * `webhooks_*` and `webhook_deliveries_list`.
 *
 * Written out rather than built by `registerCrudTools`, because two of these
 * answer with a secret the caller may never read again. The generic renderer
 * would drop it, and a create whose secret went missing is a registration nobody
 * can verify a delivery from.
 */

const listArgs = z.strictObject({
  ...listWindowShape,
  status: z.enum(WEBHOOK_STATUSES).optional().describe('active, paused, or failing.'),
})

const deliveryListArgs = z.strictObject({
  ...listWindowShape,
  webhook_id: idArg.describe('The registration whose deliveries to read.'),
  status: z.enum(WEBHOOK_DELIVERY_STATUSES).optional(),
})

export function registerWebhooksTools(mcp: McpToolRegistry, service: WebhooksService): void {
  mcp.tool({
    name: 'webhooks_list',
    description: 'List this workspace\'s webhook registrations. Mirrors GET /v1/webhooks.',
    inputSchema: listArgs,
    invoke: async (args, actor) =>
      pageResult(await service.list(actor, { status: args.status }, toListQuery(args)), webhookResponse),
  })

  mcp.tool({
    name: 'webhooks_get',
    description: 'Fetch one webhook registration. Mirrors GET /v1/webhooks/{id}.',
    inputSchema: z.strictObject({ id: idArg }),
    invoke: async ({ id }, actor) => webhookResponse(await service.get(actor, id)),
  })

  mcp.tool({
    name: 'webhooks_create',
    description:
      'Register an endpoint for record.created, record.updated, record.deleted or ' +
      'form.submitted. The reply carries the signing secret once and never again: hand it ' +
      'to whoever runs the receiver. Admin only. Mirrors POST /v1/webhooks.',
    inputSchema: createBody,
    invoke: async (body, actor) =>
      createdWebhookResponse(await service.create(actor, { url: body.url, events: body.events })),
  })

  mcp.tool({
    name: 'webhooks_update',
    description:
      'Change a registration\'s url, events, or status. status takes active or paused; ' +
      'failing is what delivery reports, not something to assert. Admin only. ' +
      'Mirrors PATCH /v1/webhooks/{id}.',
    inputSchema: updateBody.extend({ id: idArg }),
    invoke: async ({ id, ...changes }, actor) => webhookResponse(await service.update(actor, id, changes)),
  })

  mcp.tool({
    name: 'webhooks_rotate_secret',
    description:
      'Mint a replacement signing secret, answered once. overlap false retires the old one ' +
      'at once, which is what a leak calls for; true keeps signing under both for 24 hours ' +
      'so an un-redeployed receiver still verifies. Admin only. ' +
      'Mirrors POST /v1/webhooks/{id}/rotate_secret.',
    inputSchema: rotateBody.extend({ id: idArg }),
    invoke: async ({ id, overlap }, actor) =>
      createdWebhookResponse(await service.rotateSecret(actor, id, { overlap: overlap ?? false })),
  })

  mcp.tool({
    name: 'webhooks_delete',
    description: 'Remove a registration and its delivery log. Admin only. Mirrors DELETE /v1/webhooks/{id}.',
    inputSchema: z.strictObject({ id: idArg }),
    invoke: async ({ id }, actor) => {
      await service.remove(actor, id)

      return deleteResult(id)
    },
  })

  mcp.tool({
    name: 'webhook_deliveries_list',
    description:
      'Recent delivery attempts for one registration, for working out why a receiver is not ' +
      'hearing them. Keeps 30 days by default. Mirrors GET /v1/webhooks/{id}/deliveries.',
    inputSchema: deliveryListArgs,
    invoke: async (args, actor) =>
      pageResult(
        await service.listDeliveries(actor, args.webhook_id, { status: args.status }, toListQuery(args)),
        deliveryResponse,
      ),
  })
}
