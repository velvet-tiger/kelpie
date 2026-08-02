/**
 * `/healthz` sits outside `/v1`: it is the service's own liveness surface, not a
 * versioned resource. It gets its own fetch rather than an `ApiClient` method.
 */

import { isRecord } from './json.ts'

export interface ServiceHealth {
  readonly status: 'ok' | 'degraded'
  readonly database: 'up' | 'down'
}

export interface HealthRequestOptions {
  readonly url: string
  readonly fetch?: typeof globalThis.fetch
}

function decodeServiceHealth(value: unknown): ServiceHealth {
  if (!isRecord(value)) {
    throw new TypeError('Expected a health object')
  }

  const { status, database } = value

  if ((status !== 'ok' && status !== 'degraded') || (database !== 'up' && database !== 'down')) {
    throw new TypeError('Unrecognised health response')
  }

  return { status, database }
}

/** Resolves with the reported health, or rejects if the service is unreachable. */
export async function fetchServiceHealth(options: HealthRequestOptions): Promise<ServiceHealth> {
  const doFetch = options.fetch ?? globalThis.fetch.bind(globalThis)
  const response = await doFetch(options.url, { headers: { Accept: 'application/json' } })

  return decodeServiceHealth(await response.json())
}
