import { QueryClient } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { ApiProvider } from '../api/ApiProvider.tsx'
import { stubClient } from '../testing/stubClient.ts'
import { EnvironmentBanner } from './EnvironmentBanner.tsx'

afterEach(cleanup)

function renderWith(wire: { runtime_mode: string; site_name: string | null }): void {
  const client = stubClient({
    get: (path) => {
      if (path === '/public/config') {
        return wire
      }

      throw new Error(`Unexpected GET ${path}`)
    },
  })

  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })

  render(
    <ApiProvider client={client} queryClient={queryClient}>
      <EnvironmentBanner />
    </ApiProvider>,
  )
}

describe('EnvironmentBanner', () => {
  it('names the site when the mode is not production', async () => {
    renderWith({ runtime_mode: 'development', site_name: 'dev' })

    expect((await screen.findByText('dev')).textContent).toBe('dev')
  })

  it('falls back to the runtime mode when no site name is set', async () => {
    renderWith({ runtime_mode: 'development', site_name: null })

    expect((await screen.findByText('development')).textContent).toBe('development')
  })

  it('renders nothing on production', async () => {
    renderWith({ runtime_mode: 'production', site_name: 'kelpie-cloud' })

    // A tick for React Query to settle, then confirm no strip is on screen.
    await waitFor(() => {
      expect(screen.queryByText('kelpie-cloud')).toBeNull()
      expect(screen.queryByText('production')).toBeNull()
    })
  })
})
