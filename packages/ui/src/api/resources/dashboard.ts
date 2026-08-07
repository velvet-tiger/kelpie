import { dashboardSchema } from '@kelpie/schemas'
import type { Dashboard } from '@kelpie/schemas'
import { useQuery } from '@tanstack/react-query'

import { useApiClient } from '../context.ts'
import { toError } from '../errors.ts'

/**
 * `/v1/dashboard`, read-only: the workspace home in one request.
 *
 * Not a `createResourceHooks` resource. There is no collection, no id in a path,
 * and no write, so the five verbs those hooks build would all be dead.
 *
 * Nothing invalidates this key from elsewhere. Every signal is derived from
 * records other pages own, so listing the writes that could move a number here
 * would mean naming most of the API. React Query refetches it on mount and on
 * window focus, which is when a workspace home is looked at.
 */

const DASHBOARD_KEY = ['dashboard'] as const

/** How many rows each embedded list carries. The totals beside them are exact regardless. */
const SIGNAL_LIMIT = 5

export interface DashboardState {
  readonly dashboard: Dashboard | undefined
  readonly isLoading: boolean
  readonly error: Error | null
}

export function useDashboard(): DashboardState {
  const client = useApiClient()
  const result = useQuery({
    queryKey: DASHBOARD_KEY,
    queryFn: () => client.get('/dashboard', dashboardSchema.parse, { limit: SIGNAL_LIMIT }),
  })

  return { dashboard: result.data, isLoading: result.isPending, error: toError(result.error) }
}
