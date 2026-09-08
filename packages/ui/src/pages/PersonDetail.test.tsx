import { QueryClient } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
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

const LINKEDIN_PROFILE = {
  network: 'linkedin',
  url: 'https://linkedin.com/in/ada',
}

const COMPANY_ID = 'com_01hx'

const WIRE_COMPANY = {
  id: COMPANY_ID,
  name: 'Northwind',
  domain: 'northwind.dev',
  industry: null,
  description: '',
  stage: 'growth',
  size_band: '11-50',
  addresses: [],
  account_type: 'customer',
  icp_fit: 'high',
  tech_stack: [],
  summary: '',
  tags: [],
  is_own: false,
  custom_fields: {},
  created_at: '2026-07-01T00:00:00.000Z',
  updated_at: '2026-08-01T00:00:00.000Z',
}

const WIRE_POSITION = {
  id: 'pos_01hx',
  person_id: PERSON_ID,
  company_id: COMPANY_ID,
  title: 'Executive sponsor',
  created_at: '2026-07-01T00:00:00.000Z',
  updated_at: '2026-08-01T00:00:00.000Z',
}

interface PersonWireOptions {
  readonly addresses?: readonly Record<string, unknown>[]
  readonly socialProfiles?: readonly Record<string, unknown>[]
  readonly positions?: readonly Record<string, unknown>[]
  readonly companies?: readonly Record<string, unknown>[]
  readonly phones?: readonly string[]
}

function wirePerson(options: PersonWireOptions = {}): Record<string, unknown> {
  return {
    id: PERSON_ID,
    name: 'Ada Lovelace',
    salutation: null,
    first_name: 'Ada',
    last_name: 'Lovelace',
    suffix: null,
    email: 'ada@example.com',
    phones: options.phones ?? [],
    social_profiles: options.socialProfiles ?? [],
    timezone: null,
    addresses: options.addresses ?? [],
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
  options: PersonWireOptions = {},
): ApiClient {
  return stubClient({
    get: (path) => {
      if (path === '/auth/me') {
        return SESSION
      }

      if (path === `/people/${PERSON_ID}`) {
        return wirePerson(options)
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

      if (path === '/positions') {
        return { items: options.positions ?? [], nextCursor: null }
      }

      if (path === '/companies') {
        return { items: options.companies ?? [], nextCursor: null }
      }

      return { items: [], nextCursor: null }
    },
  })
}

function tabLabels(): readonly string[] {
  return screen.getAllByRole('tab').map((tab) => tab.textContent ?? '')
}

function renderPerson(eventsEnabled: boolean, options: PersonWireOptions = {}): string[] {
  const listed: string[] = []
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })

  render(
    <ApiProvider
      baseUrl="http://localhost/v1"
      client={personClient(eventsEnabled, listed, options)}
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
    renderPerson(false, { addresses: [HOME_ADDRESS] })

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

describe('PersonDetail Social tab', () => {
  it('keeps the editor on the Social tab, not the heading', async () => {
    renderPerson(false)

    await waitFor(() => {
      expect(screen.getByRole('tab', { name: 'Social' })).toBeTruthy()
    })

    expect(screen.queryByText(/One profile per network/u)).toBeNull()
    expect(screen.getByRole('tab', { name: 'Social' }).getAttribute('aria-selected')).toBe(
      'false',
    )

    fireEvent.click(screen.getByRole('tab', { name: 'Social' }))

    expect(screen.getByRole('tab', { name: 'Social' }).getAttribute('aria-selected')).toBe(
      'true',
    )
    expect(screen.getByText(/One profile per network/u)).toBeTruthy()
  })

  it('lists social profiles as icon links beside the name', async () => {
    renderPerson(false, { socialProfiles: [LINKEDIN_PROFILE] })

    const link = await screen.findByRole('link', { name: 'LinkedIn' })

    expect(link.getAttribute('href')).toBe('https://linkedin.com/in/ada')
    expect(link.getAttribute('target')).toBe('_blank')
    expect(link.querySelector('svg')).not.toBeNull()
    expect(
      screen.getByRole('tab', { name: /Social/u }).getAttribute('aria-selected'),
    ).toBe('false')
    expect(screen.queryByText(/One profile per network/u)).toBeNull()
    expect(screen.queryByText('Social profiles')).toBeNull()
  })
})

describe('PersonDetail Positions tab', () => {
  it('keeps the editor on the Positions tab, not the sidebar', async () => {
    renderPerson(false)

    await waitFor(() => {
      expect(screen.getByRole('tab', { name: 'Positions' })).toBeTruthy()
    })

    expect(screen.queryByText('No positions yet.')).toBeNull()
    expect(screen.queryByText(/Titles this person holds/u)).toBeNull()
    expect(
      screen.getByRole('tab', { name: 'Positions' }).getAttribute('aria-selected'),
    ).toBe('false')

    fireEvent.click(screen.getByRole('tab', { name: 'Positions' }))

    expect(
      screen.getByRole('tab', { name: 'Positions' }).getAttribute('aria-selected'),
    ).toBe('true')
    expect(screen.getByText(/Titles this person holds/u)).toBeTruthy()
    expect(screen.getByText('No positions yet.')).toBeTruthy()
  })

  it('lists title and company under the name, with email below', async () => {
    renderPerson(false, {
      positions: [WIRE_POSITION],
      companies: [WIRE_COMPANY],
    })

    const title = await screen.findByRole('button', { name: 'Executive sponsor' })
    const company = screen.getByRole('link', { name: 'Northwind' })

    expect(company.getAttribute('href')).toBe(`/companies/${COMPANY_ID}`)
    expect(screen.getByText('ada@example.com')).toBeTruthy()
    expect(
      screen.getByRole('tab', { name: /Positions/u }).getAttribute('aria-selected'),
    ).toBe('false')
    expect(screen.queryByText(/Titles this person holds/u)).toBeNull()

    fireEvent.click(title)

    expect(
      screen.getByRole('tab', { name: /Positions/u }).getAttribute('aria-selected'),
    ).toBe('true')
    expect(screen.getByText(/Titles this person holds/u)).toBeTruthy()
  })

  it('shows each phone below the email when the person has one', async () => {
    renderPerson(false, {
      positions: [WIRE_POSITION],
      companies: [WIRE_COMPANY],
      phones: ['+61 400 000 000', '+61 3 9000 0000'],
    })

    await screen.findByText('ada@example.com')
    const headingPhones = screen.getByRole('list', { name: 'Phone numbers' })

    expect(within(headingPhones).getByText('+61 400 000 000')).toBeTruthy()
    expect(within(headingPhones).getByText('+61 3 9000 0000')).toBeTruthy()
    expect(headingPhones.compareDocumentPosition(screen.getByText('ada@example.com'))).toBe(
      Node.DOCUMENT_POSITION_PRECEDING,
    )
  })

  it('does not show a phone line when the person has none', async () => {
    renderPerson(false, {
      positions: [WIRE_POSITION],
      companies: [WIRE_COMPANY],
    })

    await screen.findByText('ada@example.com')

    expect(screen.queryByRole('list', { name: 'Phone numbers' })).toBeNull()
  })
})
