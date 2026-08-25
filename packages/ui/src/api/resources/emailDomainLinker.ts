import { relinkEmailDomainsCountsSchema } from '@kelpie/schemas'
import type { RelinkEmailDomainsCounts } from '@kelpie/schemas'
import { useMutation, useQueryClient } from '@tanstack/react-query'

import { useApiClient } from '../context.ts'
import type { MutationResult } from '../resource.ts'
import { asMutationResult } from './mutation.ts'

/**
 * `POST /v1/workspaces/:id/relink-email-domains`: sweep every Company that
 * carries a domain and stub a Position for every workspace Person whose email
 * matches. Idempotent — a follow-up run creates no new rows.
 *
 * On success invalidates positions, activities, and the person-scoped /
 * company-scoped list joins so a page open on any of those refreshes with the
 * new links.
 */

export interface RelinkInput {
  readonly workspaceId: string
}

export function useRelinkEmailDomains(): MutationResult<RelinkInput, RelinkEmailDomainsCounts> {
  const client = useApiClient()
  const cache = useQueryClient()
  const mutation = useMutation({
    mutationFn: ({ workspaceId }: RelinkInput) =>
      client.post(
        `/workspaces/${workspaceId}/relink-email-domains`,
        {},
        relinkEmailDomainsCountsSchema.parse,
      ),
    onSuccess: async () => {
      await Promise.all(
        ['positions', 'activities', 'companies', 'people'].map((name) =>
          cache.invalidateQueries({ queryKey: [name] }),
        ),
      )
    },
  })

  return asMutationResult(mutation)
}
