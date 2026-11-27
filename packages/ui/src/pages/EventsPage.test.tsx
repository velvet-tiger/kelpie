import { QueryClient } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it } from 'vitest'

import { ApiProvider } from '../api/ApiProvider.tsx'
import type { ApiClient, QueryParameters } from '../api/client.ts'
import { stubClient } from '../testing/stubClient.ts'
import { EventsPage } from './EventsPage.tsx'

afterEach(cleanup)

/**
 * The Upcoming and Past scopes filter on "now". The page used to read the
 * clock on every render, so each render built a new query key and fetched
 * again: GitHub issue velvet-tiger/kelpie#1, a `GET /v1/events` every frame.
 */

const SESSION = {
  user_id: 'usr_1',
  session_id: 'ses_1',
  workspace_id: 'ws_1',
  role: 'owner',
  email_verified: true,
}

const PREFERENCES = {
  timezone: 'UTC',
  theme: 'system',
  email_digest: true,
  mention_emails: true,
  product_updates: true,
  list_views: {},
}

const WORKSPACE = {
  id: 'ws_1',
  name: 'Acme',
  timezone: 'UTC',
}

function eventsClient(eventQueries: (QueryParameters | undefined)[]): ApiClient {
  return stubClient({
    get: (path) => {
      if (path === '/auth/me') {
        return SESSION
      }

      if (path === '/account/preferences') {
        return PREFERENCES
      }

      if (path === '/workspaces/ws_1') {
        return WORKSPACE
      }

      throw new Error(`Unexpected get ${path}`)
    },
    list: (path, query) => {
      if (path === '/events') {
        eventQueries.push(query)
      }

      return { items: [], nextCursor: null }
    },
  })
}

function renderEvents(): (QueryParameters | undefined)[] {
  const eventQueries: (QueryParameters | undefined)[] = []
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })

  render(
    <ApiProvider
      baseUrl="http://localhost/v1"
      client={eventsClient(eventQueries)}
      queryClient={queryClient}
    >
      <MemoryRouter initialEntries={['/events']}>
        <EventsPage />
      </MemoryRouter>
    </ApiProvider>,
  )

  return eventQueries
}

async function settle(): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, 200)
  })
}

describe('EventsPage', () => {
  it('fetches the upcoming list once, not on every render', async () => {
    const eventQueries = renderEvents()

    await waitFor(() => {
      expect(eventQueries.length).toBeGreaterThan(0)
    })
    await settle()

    expect(eventQueries).toHaveLength(1)
    expect(typeof eventQueries[0]?.['from']).toBe('string')
  })

  it('fetches the past list once after switching scope', async () => {
    const eventQueries = renderEvents()

    await waitFor(() => {
      expect(eventQueries).toHaveLength(1)
    })

    fireEvent.click(screen.getByRole('button', { name: 'Past' }))

    await waitFor(() => {
      expect(eventQueries.length).toBeGreaterThan(1)
    })
    await settle()

    expect(eventQueries).toHaveLength(2)
    expect(typeof eventQueries[1]?.['to']).toBe('string')
    expect(eventQueries[1]?.['from']).toBeUndefined()
  })
})
