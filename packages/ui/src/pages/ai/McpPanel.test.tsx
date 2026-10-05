import { QueryClient } from '@tanstack/react-query'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it } from 'vitest'

import { ApiProvider } from '../../api/ApiProvider.tsx'
import { ApiError } from '../../api/client.ts'
import { setInputValue } from '../../testing/inputs.ts'
import { stubClient } from '../../testing/stubClient.ts'
import { McpPanel } from './McpPanel.tsx'

afterEach(cleanup)

/**
 * What this page can get wrong in a way a reader would believe: an endpoint URL
 * that is not the one this deployment answers on, and a tool list written into
 * the page rather than read from the registry.
 */

const TOOLS = [
  {
    name: 'people_list',
    description: 'List person records. Mirrors GET /v1/people.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'people_create',
    description: 'Create a person. Mirrors POST /v1/people.',
    input_schema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
  },
  {
    name: 'export_csv',
    description: 'Export every record of one object as CSV text.',
    input_schema: { type: 'object', properties: {} },
  },
]

interface PageStubs {
  readonly tools?: () => unknown
  readonly role?: string
}

function renderPage(stubs: PageStubs = {}): void {
  const empty = (): unknown => ({ items: [], nextCursor: null })
  const client = stubClient({
    get: (path) => {
      if (path !== '/auth/me') {
        throw new Error(`Unexpected get ${path}`)
      }

      return {
        user_id: 'usr_1',
        session_id: 'ses_1',
        workspace_id: 'ws_1',
        role: stubs.role ?? 'member',
        email_verified: true,
      }
    },
    list: (path) => {
      if (path !== '/mcp/tools') {
        throw new Error(`Unexpected list ${path}`)
      }

      return (stubs.tools ?? empty)() as { items: unknown[]; nextCursor: string | null }
    },
  })

  render(
    <MemoryRouter>
      <ApiProvider client={client} queryClient={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <McpPanel />
      </ApiProvider>
    </MemoryRouter>,
  )
}

describe('McpPanel', () => {
  it('shows the endpoint this deployment answers on, not a written-down one', async () => {
    renderPage({ tools: () => ({ items: TOOLS, nextCursor: null }) })

    // jsdom serves the page from localhost:3000, which stands in for whatever
    // host a self-hosted install is reached at.
    const endpoint = `${window.location.origin}/mcp`

    expect(await screen.findByText(endpoint)).toBeTruthy()

    // The config is behind the API key method; Sign in is the one open first.
    expect(screen.queryByText(/"url":/u)).toBeNull()
    act(() => {
      screen.getByRole('button', { name: 'API key' }).click()
    })
    expect(screen.getByText(new RegExp(`"url": "${endpoint}"`, 'u'))).toBeTruthy()
  })

  it('lists what the registry reported, with its count', async () => {
    renderPage({ tools: () => ({ items: TOOLS, nextCursor: null }) })

    expect(await screen.findByText('3 tools')).toBeTruthy()
    expect(screen.getByText('export_csv')).toBeTruthy()
    expect(screen.getByText('people_list')).toBeTruthy()
    expect(screen.getByText(/Mirrors POST \/v1\/people/u)).toBeTruthy()
  })

  it('filters on the name and on the description', async () => {
    renderPage({ tools: () => ({ items: TOOLS, nextCursor: null }) })

    const filter = await screen.findByLabelText('Filter tools')

    await act(async () => {
      setInputValue(filter, 'CSV')
    })

    expect(screen.getByText('export_csv')).toBeTruthy()
    expect(screen.queryByText('people_list')).toBeNull()

    await act(async () => {
      setInputValue(filter, 'nothing here')
    })

    expect(screen.getByText(/No tool matches/u)).toBeTruthy()
  })

  it('says the listing failed rather than showing no tools', async () => {
    renderPage({
      tools: () => Promise.reject(new ApiError(401, 'unauthorized', 'Your session has expired')),
    })

    await waitFor(() => {
      expect(screen.getByText('Your session has expired')).toBeTruthy()
    })
  })

  it('opens on Sign in, with the link to disconnect a client', async () => {
    renderPage()

    expect(screen.getByRole('button', { name: 'Sign in' }).getAttribute('aria-pressed')).toBe('true')
    expect((await screen.findByRole('link', { name: 'Connected apps' })).getAttribute('href')).toBe(
      '/account/connected-apps',
    )
  })

  it('sends a member to personal keys, with no link into Admin', async () => {
    renderPage({ role: 'member' })
    act(() => {
      screen.getByRole('button', { name: 'API key' }).click()
    })

    expect((await screen.findByRole('link', { name: 'API keys' })).getAttribute('href')).toBe('/account/api-keys')
    // Wait for the role, so the missing link is not only a session still loading.
    await screen.findByText('0 tools')
    expect(screen.queryByRole('link', { name: 'Admin → API keys' })).toBeNull()
    // Agent registration is configuration, and is on Admin → AI.
    expect(screen.queryByText('Registered agents')).toBeNull()
  })

  it('adds the workspace keys link for an admin', async () => {
    renderPage({ role: 'admin' })
    act(() => {
      screen.getByRole('button', { name: 'API key' }).click()
    })

    expect((await screen.findByRole('link', { name: 'Admin → API keys' })).getAttribute('href')).toBe(
      '/admin/api-keys',
    )
  })
})
