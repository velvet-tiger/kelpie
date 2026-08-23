import { sampleDataCountsSchema } from '@kelpie/schemas'
import type { SampleDataCounts } from '@kelpie/schemas'
import { useMutation, useQueryClient } from '@tanstack/react-query'

import { useApiClient } from '../context.ts'
import type { MutationResult } from '../resource.ts'
import { asMutationResult } from './mutation.ts'

/**
 * `POST /v1/workspaces/:id/sample-data`: install the sample workspace.
 *
 * The workspace id arrives as a mutation argument rather than being read from
 * the session. That lets the onboarding wizard install into the workspace it
 * just created, before the session cache catches up with it.
 *
 * On success, every CRM list is invalidated because the rows this just wrote
 * are in all of them.
 */

export interface InstallSampleDataInput {
  readonly workspaceId: string
}

export function useInstallSampleData(): MutationResult<InstallSampleDataInput, SampleDataCounts> {
  const client = useApiClient()
  const cache = useQueryClient()
  const mutation = useMutation({
    mutationFn: ({ workspaceId }: InstallSampleDataInput) =>
      client.post(
        `/workspaces/${workspaceId}/sample-data`,
        {},
        sampleDataCountsSchema.parse,
      ),
    onSuccess: async () => {
      await Promise.all(
        [
          'people',
          'companies',
          'positions',
          'deals',
          'plans',
          'notes',
          'activities',
          'decisions',
          'opportunities',
          'raises',
          'partnerships',
          'roles',
          'candidates',
        ].map((name) => cache.invalidateQueries({ queryKey: [name] })),
      )
    },
  })

  return asMutationResult(mutation)
}
