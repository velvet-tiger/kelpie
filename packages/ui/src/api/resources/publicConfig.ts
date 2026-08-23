import { publicConfigSchema } from '@kelpie/schemas'
import type { PublicConfig } from '@kelpie/schemas'
import { useQuery } from '@tanstack/react-query'

import { useApiClient } from '../context.ts'
import { toError } from '../errors.ts'

/**
 * The deployment metadata `GET /v1/public/config` reports.
 *
 * Read once, cached forever: neither `runtimeMode` nor `siteName` changes
 * while the app is open. The endpoint is public, so this hook works before a
 * session exists (the sign-in page reads it too).
 */

const PUBLIC_CONFIG_KEY = ['public-config'] as const

export interface PublicConfigState {
  readonly config: PublicConfig | undefined
  readonly isLoading: boolean
  readonly error: Error | null
}

export function usePublicConfig(): PublicConfigState {
  const client = useApiClient()
  const result = useQuery({
    queryKey: PUBLIC_CONFIG_KEY,
    queryFn: () => client.get('/public/config', publicConfigSchema.parse),
    staleTime: Infinity,
  })

  return { config: result.data, isLoading: result.isPending, error: toError(result.error) }
}
