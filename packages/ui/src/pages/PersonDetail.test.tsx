import { QueryClient } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, describe, expect, it } from 'vitest'

import { ApiProvider } from '../api/ApiProvider.tsx'
import type { ApiClient } from '../api/client.ts'
import { stubClient } from '../testing/stubClient.ts'
import { PersonDetail } from './PersonDetail.tsx'

afterEach(cleanup)

/**
 * The Events tab on a person is core UI for a toggleable module. These cover
 * the case that used to leak it: a workspace with Events off still showed the
 * tab, and the attendances list answered 403 inside it.
 */

const PERSON_ID = 'person_01hx'

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
  slug: 'acme',
  timezone: 'UTC',
}

const HOME_ADDRESS = {
  kind: 'home',
  line1: '42 Gertrude Street',
  line2: null,
  city: 'Fitzroy',
  region: 'VIC',
  postal_code: '3065',
  country: 'AU',
  primary: true,
}

function wirePerson(
  addresses: readonly Record<string, unknown>[] = [],
): Record<string, unknown> {
  return {
    id: PERSON_ID,
    name: 'Ada Lovelace',
    salutation: null,
    first_name: 'Ada',
    last_name: 'Lovelace',
    suffix: null,
    email: 'ada@example.com',
    phones: [],
    social_profiles: [],
    timezone: null,
    addresses,
    preferred_channel: 'email',
    influence: 'decision_maker',
    relationship: 'cold',
    summary: '',
    tags: [],
    last_contacted_at: null,
    do_not_contact: false,
    consents: [],
    custom_fields: {},
    created_at: '2026-07-01T00:00:00.000Z',
    updated_at: '2026-08-01T00:00:00.000Z',
  }
}

function personClient(
  eventsEnabled: boolean,
  listed: string[],
  addresses: readonly Record<string, unknown>[] = [],
): ApiClient {
  return stubClient({
    get: (path) => {
      if (path === '/auth/me') {
        return SESSION
      }

      if (path === `/people/${PERSON_ID}`) {
        return wirePerson(addresses)
      }

      if (path === '/account/preferences') {
        return PREFERENCES
      }

      if (path === '/workspaces/ws_1') {
        return WORKSPACE
      }

      throw new Error(`Unexpected get ${path}`)
    },
    list: (path) => {
      listed.push(path)

      if (path === '/workspaces/ws_1/modules') {
        return {
          items: [{ module_id: 'events', enabled: eventsEnabled, locked: false }],
          nextCursor: null,
        }
      }

      return { items: [], nextCursor: null }
    },
  })
}

function tabLabels(): readonly string[] {
  return screen.getAllByRole('tab').map((tab) => tab.textContent ?? '')
}

function renderPerson(
  eventsEnabled: boolean,
  addresses: readonly Record<string, unknown>[] = [],
): string[] {
  const listed: string[] = []
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })

  render(
    <ApiProvider
      baseUrl="http://localhost/v1"
      client={personClient(eventsEnabled, listed, addresses)}
      queryClient={queryClient}
    >
      <MemoryRouter initialEntries={[`/people/${PERSON_ID}`]}>
        <Routes>
          <Route path="people/:id" element={<PersonDetail />} />
        </Routes>
      </MemoryRouter>
    </ApiProvider>,
  )

  return listed
}

describe('PersonDetail Events tab', () => {
  it('hides the Events tab when the workspace has switched Events off', async () => {
    const listed = renderPerson(false)

    await waitFor(() => {
      expect(tabLabels()).toContain('Overview')
      expect(listed).toContain('/workspaces/ws_1/modules')
    })

    expect(tabLabels()).not.toContain('Events')
    expect(listed).not.toContain('/attendances')
  })

  it('shows the Events tab when the workspace has Events on', async () => {
    renderPerson(true)

    await waitFor(() => {
      expect(tabLabels()).toContain('Events')
    })
  })
})

describe('PersonDetail Addresses tab', () => {
  it('keeps the editor on the Addresses tab, not the sidebar', async () => {
    renderPerson(false)

    await waitFor(() => {
      expect(screen.getByRole('tab', { name: 'Addresses' })).toBeTruthy()
    })

    expect(screen.getByRole('button', { name: 'Add address…' })).toBeTruthy()
    expect(screen.queryByText(/Mark one as primary/u)).toBeNull()
    expect(
      screen.getByRole('tab', { name: 'Addresses' }).getAttribute('aria-selected'),
    ).toBe('false')

    fireEvent.click(screen.getByRole('button', { name: 'Add address…' }))

    expect(
      screen.getByRole('tab', { name: 'Addresses' }).getAttribute('aria-selected'),
    ).toBe('true')
    expect(screen.getByText(/Mark one as primary/u)).toBeTruthy()
  })

  it('opens the Addresses tab from the primary address in the sidebar', async () => {
    renderPerson(false, [HOME_ADDRESS])

    const link = await screen.findByRole('button', {
      name: '42 Gertrude Street, Fitzroy, VIC, 3065, Australia',
    })

    expect(
      screen.getByRole('tab', { name: /Addresses/u }).getAttribute('aria-selected'),
    ).toBe('false')
    expect(screen.queryByText('Home')).toBeNull()

    fireEvent.click(link)

    expect(
      screen.getByRole('tab', { name: /Addresses/u }).getAttribute('aria-selected'),
    ).toBe('true')
    expect(screen.getByText('Home')).toBeTruthy()
    expect(screen.getByText('Primary')).toBeTruthy()
  })
})
