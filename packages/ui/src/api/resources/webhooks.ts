import { createWebhookBody, createdWebhookSchema, webhookBody, webhookSchema } from '@kelpie/schemas'
import type { CreateWebhookInput, CreatedWebhook, Webhook, WebhookInput } from '@kelpie/schemas'
import { useMutation, useQueryClient } from '@tanstack/react-query'

import type { QueryParameters } from '../client.ts'
import { useApiClient } from '../context.ts'
import { createResourceHooks } from '../resource.ts'
import type { MutationResult, RecordListResult, UpdateArguments } from '../resource.ts'
import { asMutationResult } from './mutation.ts'

/**
 * `/v1/webhooks`: outbound event delivery.
 *
 * Every verb needs the admin role, reads included, so a member's list request
 * answers `403` and the page renders that rather than an empty table. A webhook
 * URL routinely carries its own credential in the path, which is what puts
 * reading them alongside API keys.
 */

const webhooks = createResourceHooks<Webhook, CreateWebhookInput, WebhookInput>({
  name: 'webhooks',
  path: '/webhooks',
  decode: webhookSchema.parse,
  createBody: createWebhookBody,
  updateBody: webhookBody,
})

export interface WebhookFilters {
  readonly status?: Webhook['status']
}

function webhookQuery(filters: WebhookFilters): QueryParameters {
  return { status: filters.status }
}

export function useWebhooks(filters: WebhookFilters = {}): RecordListResult<Webhook> {
  return webhooks.useList(webhookQuery(filters))
}

export function useUpdateWebhook(): MutationResult<UpdateArguments<WebhookInput>, Webhook> {
  return webhooks.useUpdate()
}

export function useDeleteWebhook(): MutationResult<string, void> {
  return webhooks.useRemove()
}

/**
 * Registers a webhook.
 *
 * Written out rather than taken from `createResourceHooks`, because the `201`
 * is the only response that ever carries the signing secret and the shared hook
 * decodes with the schema that has no such field. The secret has to survive the
 * decode: it cannot be fetched again, so a page that dropped it would have
 * created a webhook nobody can verify deliveries from.
 */
export function useCreateWebhook(): MutationResult<CreateWebhookInput, CreatedWebhook> {
  const client = useApiClient()
  const queryClient = useQueryClient()
  const mutation = useMutation({
    mutationFn: (input: CreateWebhookInput) =>
      client.post('/webhooks', createWebhookBody(input), createdWebhookSchema.parse),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ['webhooks', 'list'] })
    },
  })

  return asMutationResult(mutation)
}
