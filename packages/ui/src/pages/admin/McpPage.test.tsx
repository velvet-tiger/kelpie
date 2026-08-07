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

const AGENTS = [
  {
    id: 'ag_1',
    name: 'Local Claude',
    endpoint: 'https://agents.example.com/kelpie/run',
    has_auth_header: true,
    last_run_at: '2026-08-07T01:00:00.000Z',
    created_at: '2026-08-01T01:00:00.000Z',
    updated_at: '2026-08-01T01:00:00.000Z',
  },
]

const RUNS = [
  {
    id: 'run_1',
    agent_id: 'ag_1',
    task_id: 'company.enrich',
    target_type: 'company',
    target_id: 'com_1',
    status: 'failed',
    prompt: '# Agent task: Enrich company',
    failure_reason: 'agent endpoint answered 500',
    created_at: '2026-08-07T01:00:00.000Z',
    updated_at: '2026-08-07T01:00:05.000Z',
  },
]

const TASK_DEFINITIONS = [
  {
    id: 'company.enrich',
    label: 'Enrich company',
    description: 'Research into description, stage, size, stack, tags, summary.',
    target_types: ['company'],
    placement: 'primary',
    handbook_slugs: ['agent-faq'],
    instructions: 'Research this Company.',
    write_policy: '- Prefer appending a Note over inventing facts.',
  },
]

interface PageStubs {
  readonly tools?: () => unknown
  readonly agents?: () => unknown
  readonly runs?: () => unknown
}

function renderPage(stubs: PageStubs = {}): void {
  const empty = (): unknown => ({ items: [], nextCursor: null })
  const client = stubClient({
    list: (path) => {
      const answer =
        {
          '/mcp/tools': stubs.tools ?? empty,
          '/agents': stubs.agents ?? empty,
          '/agent-runs': stubs.runs ?? empty,
          '/agent-tasks': () => ({ items: TASK_DEFINITIONS, nextCursor: null }),
        }[path] ?? (() => {
          throw new Error(`Unexpected list ${path}`)
        })

      return answer() as { items: unknown[]; nextCursor: string | null }
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
    renderPage({ tools: () => ({ items: TOOLS, nextCursor: null }) })

    // jsdom serves the page from localhost:3000, which stands in for whatever
    // host a self-hosted install is reached at.
    const endpoint = `${window.location.origin}/mcp`

    expect(await screen.findByText(endpoint)).toBeTruthy()
    expect(screen.getByText(new RegExp(`"url": "${endpoint}"`, 'u'))).toBeTruthy()
  })

  it('lists what the registry reported, with its count', async () => {
    renderPage({ tools: () => ({ items: TOOLS, nextCursor: null }) })

    expect(await screen.findByText(/3 tools/u)).toBeTruthy()
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

  it('lists registered agents with their endpoint and last run', async () => {
    renderPage({ agents: () => ({ items: AGENTS, nextCursor: null }) })

    expect(await screen.findByText('Local Claude')).toBeTruthy()
    expect(screen.getByText('https://agents.example.com/kelpie/run')).toBeTruthy()
    expect(screen.getByText('Auth header set')).toBeTruthy()
    expect(screen.getByText(/Last run/u)).toBeTruthy()
  })

  it('labels run-log rows from the catalog, with the failure reason', async () => {
    renderPage({
      agents: () => ({ items: AGENTS, nextCursor: null }),
      runs: () => ({ items: RUNS, nextCursor: null }),
    })

    expect(await screen.findByText('Enrich company')).toBeTruthy()
    expect(screen.getByText(/com_1 → Local Claude/u)).toBeTruthy()
    expect(screen.getByText('Failed')).toBeTruthy()
    expect(screen.getByText('agent endpoint answered 500')).toBeTruthy()
  })

  it('says so when nothing has run yet', async () => {
    renderPage()

    expect(await screen.findByText(/No runs yet/u)).toBeTruthy()
    expect(screen.getByText(/No agents registered/u)).toBeTruthy()
  })
})
