import { QueryClientProvider } from '@tanstack/react-query'
import type { QueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import type { ReactNode } from 'react'

import { createApiClient } from './client.ts'
import type { ApiClient } from './client.ts'
import { ApiClientContext } from './context.ts'
import { createQueryClient } from './queryClient.ts'

export interface ApiProviderProps {
  /** Origin plus base path, e.g. `/v1` in the browser. */
  readonly baseUrl?: string | undefined
  /** A prepared client, for tests and for assemblies that construct their own. */
  readonly client?: ApiClient | undefined
  readonly queryClient?: QueryClient | undefined
  readonly children: ReactNode
}

/**
 * Puts an API client and a query cache in reach of the tree below it.
 *
 * Both are held in state rather than built inline, because a fresh
 * `QueryClient` on every render throws the cache away on every render.
 */
export function ApiProvider({
  baseUrl = '/v1',
  client,
  queryClient,
  children,
}: ApiProviderProps): React.JSX.Element {
  const [resolvedClient] = useState<ApiClient>(() => client ?? createApiClient({ baseUrl }))
  const [resolvedQueryClient] = useState<QueryClient>(() => queryClient ?? createQueryClient())

  return (
    <QueryClientProvider client={resolvedQueryClient}>
      <ApiClientContext value={resolvedClient}>{children}</ApiClientContext>
    </QueryClientProvider>
  )
}
