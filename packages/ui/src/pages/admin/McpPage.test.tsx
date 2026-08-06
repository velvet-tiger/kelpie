import { QueryClient } from '@tanstack/react-query'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it } from 'vitest'

import { ApiProvider } from '../../api/ApiProvider.tsx'
import { ApiError } from '../../api/client.ts'
import { setInputValue } from '../../testing/inputs.ts'
import { stubClient } from '../../testing/stubClient.ts'
import { McpPage } from './McpPage.tsx'

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

function renderPage(answer: () => unknown): void {
  const client = stubClient({
    list: (path) => {
      if (path !== '/mcp/tools') {
        throw new Error(`Unexpected list ${path}`)
      }

      const result = answer()

      return result as { items: unknown[]; nextCursor: string | null }
    },
  })

  render(
    <MemoryRouter>
      <ApiProvider client={client} queryClient={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <McpPage />
      </ApiProvider>
    </MemoryRouter>,
  )
}

describe('McpPage', () => {
  it('shows the endpoint this deployment answers on, not a written-down one', async () => {
    renderPage(() => ({ items: TOOLS, nextCursor: null }))

    // jsdom serves the page from localhost:3000, which stands in for whatever
    // host a self-hosted install is reached at.
    const endpoint = `${window.location.origin}/mcp`

    expect(await screen.findByText(endpoint)).toBeTruthy()
    expect(screen.getByText(new RegExp(`"url": "${endpoint}"`, 'u'))).toBeTruthy()
  })

  it('lists what the registry reported, with its count', async () => {
    renderPage(() => ({ items: TOOLS, nextCursor: null }))

    expect(await screen.findByText(/3 tools/u)).toBeTruthy()
    expect(screen.getByText('export_csv')).toBeTruthy()
    expect(screen.getByText('people_list')).toBeTruthy()
    expect(screen.getByText(/Mirrors POST \/v1\/people/u)).toBeTruthy()
  })

  it('filters on the name and on the description', async () => {
    renderPage(() => ({ items: TOOLS, nextCursor: null }))

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
    renderPage(() => Promise.reject(new ApiError(401, 'unauthorized', 'Your session has expired')))

    await waitFor(() => {
      expect(screen.getByText('Your session has expired')).toBeTruthy()
    })
  })
})
