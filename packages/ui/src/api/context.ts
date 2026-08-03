import { createContext, useContext } from 'react'

import type { ApiClient } from './client.ts'

/**
 * Reading the API client from a component.
 *
 * There is no default. A page that renders without a provider would otherwise
 * fetch from an unset base URL and fail somewhere in the network layer, a long
 * way from the missing wiring that caused it.
 *
 * The provider lives in its own file so Fast Refresh keeps working; a module
 * that exports both a component and a hook loses it.
 */
export const ApiClientContext = createContext<ApiClient | null>(null)

export function useApiClient(): ApiClient {
  const client = useContext(ApiClientContext)

  if (client === null) {
    throw new Error('No ApiClient in context. Wrap the tree in <ApiProvider>.')
  }

  return client
}
