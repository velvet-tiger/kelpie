import { QueryClient } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { ApiProvider } from '../api/ApiProvider.tsx'
import { stubClient } from '../testing/stubClient.ts'
import { AgentTasks } from './AgentTasks.tsx'

afterEach(cleanup)

/**
 * The two triggers `agent-tasks.md` defines: Copy resolves and takes the
 * prompt, Run resolves and dispatches to a registered agent. Both go through
 * the same resolve request, which is what these tests pin.
 */

const TASKS = [
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
  {
    id: 'company.distill_notes',
    label: 'Distill notes',
    description: 'Pin high-signal notes.',
    target_types: ['company'],
    placement: 'overflow',
    handbook_slugs: ['agent-faq'],
    instructions: 'Review notes on this Company.',
    write_policy: '- Prefer appending a Note over inventing facts.',
  },
]

const RESOLVED = {
  task_id: 'company.enrich',
  target_type: 'company',
  target_id: 'com_1',
  prompt: '# Agent task: Enrich company\n\nResolved for Brightline Health.',
  context: {
    target_label: 'Brightline Health',
    deep_link: '/companies/com_1',
    handbook_slugs: ['agent-faq'],
    pinned_note_ids: [],
    open_plan_ids: [],
    open_decision_ids: [],
    related: {},
  },
}

const AGENT = {
  id: 'ag_1',
  name: 'Local Claude',
  endpoint: 'https://agents.example.com/kelpie/run',
  has_auth_header: false,
  last_run_at: null,
  created_at: '2026-08-01T01:00:00.000Z',
  updated_at: '2026-08-01T01:00:00.000Z',
}

function runWire(status: string): Record<string, unknown> {
  return {
    id: 'run_1',
    agent_id: 'ag_1',
    task_id: 'company.enrich',
    target_type: 'company',
    target_id: 'com_1',
    status,
    prompt: RESOLVED.prompt,
    failure_reason: status === 'failed' ? 'agent endpoint answered 500' : null,
    created_at: '2026-08-07T01:00:00.000Z',
    updated_at: '2026-08-07T01:00:00.000Z',
  }
}

interface Recorded {
  readonly posts: { path: string; body: unknown }[]
}

function renderComponent(overrides: { runStatus?: string } = {}): Recorded {
  const recorded: Recorded = { posts: [] }
  const client = stubClient({
    list: (path) => {
      if (path === '/agent-tasks') {
        return { items: TASKS, nextCursor: null }
      }

      if (path === '/agents') {
        return { items: [AGENT], nextCursor: null }
      }

      throw new Error(`Unexpected list ${path}`)
    },
    post: (path, body) => {
      recorded.posts.push({ path, body })

      if (path.endsWith('/resolve')) {
        return RESOLVED
      }

      if (path.endsWith('/run')) {
        return runWire('queued')
      }

      throw new Error(`Unexpected post ${path}`)
    },
    get: (path) => {
      if (path === '/agent-runs/run_1') {
        return runWire(overrides.runStatus ?? 'succeeded')
      }

      throw new Error(`Unexpected get ${path}`)
    },
  })

  render(
    <ApiProvider
      client={client}
      queryClient={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <AgentTasks targetType="company" targetId="com_1" targetLabel="Brightline Health" />
    </ApiProvider>,
  )

  return recorded
}

async function openMenu(): Promise<void> {
  fireEvent.click(screen.getByRole('button', { name: /Agent/u }))
  await screen.findByText('Enrich company')
}

describe('AgentTasks', () => {
  it('lists the catalog for the target type, primary before overflow', async () => {
    renderComponent()
    await openMenu()

    expect(screen.getByText('Actions')).toBeTruthy()
    expect(screen.getByText('More')).toBeTruthy()
    expect(screen.getByText('Distill notes')).toBeTruthy()
  })

  it('previews the resolved prompt for this target', async () => {
    const recorded = renderComponent()
    await openMenu()

    fireEvent.click(screen.getAllByRole('button', { name: 'Preview' })[0] as HTMLElement)

    expect(await screen.findByText(/Resolved for Brightline Health/u)).toBeTruthy()
    expect(recorded.posts).toEqual([
      {
        path: '/agent-tasks/company.enrich/resolve',
        body: { target_type: 'company', target_id: 'com_1' },
      },
    ])
  })

  it('dispatches a run to the chosen agent and reports the settled status', async () => {
    const recorded = renderComponent()
    await openMenu()

    fireEvent.click(screen.getAllByRole('button', { name: 'Run' })[0] as HTMLElement)

    await screen.findByText(/Resolved for Brightline Health/u)
    await screen.findByRole('option', { name: 'Local Claude' })

    fireEvent.click(screen.getByRole('button', { name: 'Dispatch run' }))

    await waitFor(() => {
      expect(screen.getByText(/Dispatched\./u)).toBeTruthy()
    })
    expect(
      recorded.posts.some(
        (post) =>
          post.path === '/agent-tasks/company.enrich/run' &&
          JSON.stringify(post.body) ===
            JSON.stringify({ target_type: 'company', target_id: 'com_1', agent_id: 'ag_1' }),
      ),
    ).toBe(true)
  })

  it('shows the failure reason when the dispatch fails', async () => {
    renderComponent({ runStatus: 'failed' })
    await openMenu()

    fireEvent.click(screen.getAllByRole('button', { name: 'Run' })[0] as HTMLElement)
    await screen.findByRole('option', { name: 'Local Claude' })
    fireEvent.click(screen.getByRole('button', { name: 'Dispatch run' }))

    await waitFor(() => {
      expect(screen.getByText(/agent endpoint answered 500/u)).toBeTruthy()
    })
    expect(screen.getByRole('button', { name: 'Retry run' })).toBeTruthy()
  })
})
