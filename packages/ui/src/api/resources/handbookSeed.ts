import { seedHandbookBody, seedHandbookResultSchema } from '@kelpie/schemas'
import type { SeedHandbookInput, SeedHandbookResult } from '@kelpie/schemas'
import { useMutation, useQueryClient } from '@tanstack/react-query'

import { useApiClient } from '../context.ts'
import type { MutationResult } from '../resource.ts'
import { asMutationResult } from './mutation.ts'
import { useSession } from './session.ts'

/**
 * `POST /v1/workspaces/:id/handbook/seed` — onboarding step 4 seeds the starter
 * handbook once the reader has picked an organisation type.
 */

export function useSeedHandbook(): MutationResult<
  SeedHandbookInput & { readonly workspaceId: string },
  SeedHandbookResult
> {
  const client = useApiClient()
  const queryClient = useQueryClient()

  const mutation = useMutation({
    mutationFn: ({ workspaceId, ...input }: SeedHandbookInput & { readonly workspaceId: string }) =>
      client.post(
        `/workspaces/${workspaceId}/handbook/seed`,
        seedHandbookBody(input),
        seedHandbookResultSchema.parse,
      ),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['handbook_pages'] })
    },
  })

  return asMutationResult(mutation)
}

export function useSeedHandbookForWorkspace(): MutationResult<SeedHandbookInput, SeedHandbookResult> {
  const { session } = useSession()
  const seedHandbook = useSeedHandbook()

  return {
    run: (input: SeedHandbookInput) => {
      const workspaceId = session?.workspaceId

      if (workspaceId === null || workspaceId === undefined) {
        return
      }

      seedHandbook.run({ ...input, workspaceId })
    },
    runAsync: async (input: SeedHandbookInput) => {
      const workspaceId = session?.workspaceId

      if (workspaceId === null || workspaceId === undefined) {
        throw new Error('No workspace is active')
      }

      return seedHandbook.runAsync({ ...input, workspaceId })
    },
    isPending: seedHandbook.isPending,
    error: seedHandbook.error,
  }
}
