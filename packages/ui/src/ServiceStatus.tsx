import { useEffect, useState } from 'react'

import { fetchServiceHealth } from './api/health.ts'
import type { ServiceHealth } from './api/health.ts'

/**
 * Placeholder root view. It exists so the UI build and the API wiring are both
 * exercised end to end; the mockup pages replace it during the Phase 1 port.
 */

type HealthState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'loaded'; readonly health: ServiceHealth }
  | { readonly kind: 'unreachable'; readonly reason: string }

export interface ServiceStatusProps {
  /** Path or URL of the service health endpoint. */
  readonly healthUrl: string
}

export function ServiceStatus({ healthUrl }: ServiceStatusProps): React.JSX.Element {
  const [state, setState] = useState<HealthState>({ kind: 'loading' })

  useEffect(() => {
    let active = true

    fetchServiceHealth({ url: healthUrl })
      .then((health) => {
        if (active) {
          setState({ kind: 'loaded', health })
        }
      })
      .catch((error: unknown) => {
        if (active) {
          setState({ kind: 'unreachable', reason: error instanceof Error ? error.message : String(error) })
        }
      })

    return () => {
      active = false
    }
  }, [healthUrl])

  return (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col justify-center gap-3 px-6">
      <h1 className="text-2xl font-semibold">Kelpie</h1>
      <p className="text-sm text-gray-600">{describe(state)}</p>
    </main>
  )
}

function describe(state: HealthState): string {
  switch (state.kind) {
    case 'loading':
      return 'Checking the service…'
    case 'loaded':
      return `Service ${state.health.status}, database ${state.health.database}.`
    case 'unreachable':
      return `Service unreachable: ${state.reason}`
  }
}
