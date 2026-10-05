import { QueryClient } from '@tanstack/react-query'
import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it } from 'vitest'

import { ApiProvider } from '../../api/ApiProvider.tsx'
import { stubClient } from '../../testing/stubClient.ts'
import { AgentsPanel } from './AgentsPanel.tsx'

afterEach(cleanup)

const AGENTS = [
  {
    id: 'ag_1',
    name: 'Local Claude',
    endpoint: 'https://agents.example.com/kelpie/run',
    has_auth_header: true,
    managed_by: null,
    settings_path: null,
    last_run_at: '2026-08-07T01:00:00.000Z',
    created_at: '2026-08-01T01:00:00.000Z',
    updated_at: '2026-08-01T01:00:00.000Z',
  },
]

const MANAGED_AGENT = {
  id: 'ag_2',
  name: 'Hosted agent',
  endpoint: 'module:ai',
  has_auth_header: true,
  managed_by: 'ai',
  settings_path: '/admin/ai',
  last_run_at: null,
  created_at: '2026-08-01T01:00:00.000Z',
  updated_at: '2026-08-01T01:00:00.000Z',
}

const RUNS = [
  {
    id: 'run_1',
    agent_id: 'ag_1',
    task_id: 'company.enrich',
    target_type: 'company',
    target_id: 'com_1',
    status: 'failed',
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
  readonly agents?: () => unknown
  readonly runs?: () => unknown
}

function renderPanel(stubs: PageStubs = {}): void {
  const empty = (): unknown => ({ items: [], nextCursor: null })
  const client = stubClient({
    list: (path) => {
      const answer =
        {
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
        <AgentsPanel />
      </ApiProvider>
    </MemoryRouter>,
  )
}

describe('AgentsPanel', () => {
  it('lists registered agents with their endpoint and last run', async () => {
    renderPanel({ agents: () => ({ items: AGENTS, nextCursor: null }) })

    expect(await screen.findByText('Local Claude')).toBeTruthy()
    expect(screen.getByText('https://agents.example.com/kelpie/run')).toBeTruthy()
    expect(screen.getByText('Auth header set')).toBeTruthy()
    expect(screen.getByText(/Last run/u)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Remove' })).toBeTruthy()
  })

  it('links a module-managed agent to its settings instead of offering Remove', async () => {
    renderPanel({ agents: () => ({ items: [MANAGED_AGENT], nextCursor: null }) })

    expect(await screen.findByText('Hosted agent')).toBeTruthy()
    // Dispatched in-process: the stored endpoint is not shown as an address.
    expect(screen.getByText('Runs inside Kelpie (ai module)')).toBeTruthy()
    expect(screen.queryByText('module:ai')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Remove' })).toBeNull()
    expect(screen.getByRole('link', { name: 'Manage in settings' }).getAttribute('href')).toBe(
      '/admin/ai',
    )
  })

  it('says a module manages the agent when the module gave no settings path', async () => {
    renderPanel({
      agents: () => ({ items: [{ ...MANAGED_AGENT, settings_path: null }], nextCursor: null }),
    })

    expect(await screen.findByText('Managed by a module')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Remove' })).toBeNull()
  })

  it('labels run-log rows from the catalog, with the failure reason', async () => {
    renderPanel({
      agents: () => ({ items: AGENTS, nextCursor: null }),
      runs: () => ({ items: RUNS, nextCursor: null }),
    })

    expect(await screen.findByText('Enrich company')).toBeTruthy()
    expect(screen.getByText(/com_1 → Local Claude/u)).toBeTruthy()
    expect(screen.getByText('Failed')).toBeTruthy()
    expect(screen.getByText('agent endpoint answered 500')).toBeTruthy()
  })

  it('says so when nothing has run yet', async () => {
    renderPanel()

    expect(await screen.findByText(/No runs yet/u)).toBeTruthy()
    expect(screen.getByText(/No agents registered/u)).toBeTruthy()
  })
})
