import { apiKeySchema, createApiKeyBody, createdApiKeySchema } from '@kelpie/schemas'
import type { ApiKey, ApiKeyKind, CreateApiKeyInput, CreatedApiKey } from '@kelpie/schemas'
import { useMutation, useQueryClient } from '@tanstack/react-query'

import { useApiClient } from '../context.ts'
import { createReadOnlyResourceHooks } from '../resource.ts'
import type { MutationResult, RecordListResult } from '../resource.ts'
import { asMutationResult } from './mutation.ts'

/**
 * `/v1/api-keys`: workspace keys and personal keys, one endpoint told apart by
 * `kind`. `kind` is required on every list request — the server answers `422`
 * without it — so each page asks for exactly the one kind it manages.
 */

const { useList } = createReadOnlyResourceHooks<ApiKey>({
  name: 'apiKeys',
  path: '/api-keys',
  decode: apiKeySchema.parse,
})

export function useApiKeys(kind: ApiKeyKind): RecordListResult<ApiKey> {
  return useList({ kind })
}

/**
 * Mints a key.
 *
 * Written out rather than taken from `createResourceHooks`, because the `201`
 * is the only response that ever carries the secret and the shared hook decodes
 * with the schema that has no such field. The secret has to survive the decode:
 * it cannot be fetched again, so a page that dropped it would have created a key
 * nobody can use.
 */
export function useCreateApiKey(): MutationResult<CreateApiKeyInput, CreatedApiKey> {
  const client = useApiClient()
  const queryClient = useQueryClient()
  const mutation = useMutation({
    mutationFn: (input: CreateApiKeyInput) =>
      client.post('/api-keys', createApiKeyBody(input), createdApiKeySchema.parse),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ['apiKeys', 'list'] })
    },
  })

  return asMutationResult(mutation)
}

export function useRevokeApiKey(): MutationResult<string, void> {
  const client = useApiClient()
  const queryClient = useQueryClient()
  const mutation = useMutation({
    mutationFn: (id: string) => client.delete(`/api-keys/${id}`),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ['apiKeys', 'list'] })
    },
  })

  return asMutationResult(mutation)
}
