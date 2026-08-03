import { QueryClient } from '@tanstack/react-query'

import { ApiError } from './client.ts'

/**
 * Cache defaults for the whole app.
 *
 * The two that matter:
 *
 * `staleTime` is 30 seconds, not zero. Zero refetches every list on every
 * navigation, which turns a click from People back to People into a network
 * round trip and a visible flash. Thirty seconds keeps the screen instant while
 * still catching a change another tab or an agent made.
 *
 * Retries skip client errors. Retrying a `422` or a `404` cannot succeed, and
 * retrying a `401` three times is three chances to lock an account out. Only
 * `5xx` and transport failures are worth a second attempt.
 */
export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        retry: (failureCount, error) => failureCount < 2 && isWorthRetrying(error),
      },
      mutations: {
        retry: false,
      },
    },
  })
}

function isWorthRetrying(error: unknown): boolean {
  return !(error instanceof ApiError) || error.status >= 500
}
