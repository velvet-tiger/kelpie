import { QueryClient } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { ApiProvider } from '../api/ApiProvider.tsx'
import { aiUi } from '../modules/ai.tsx'
import { UiExtensionProvider } from '../registry/UiExtensionProvider.tsx'
import { NO_UI_MODULES, registerUiModules } from '../registry/registry.ts'
import { stubClient } from '../testing/stubClient.ts'
import { AgentTasks } from './AgentTasks.tsx'

afterEach(cleanup)

/**
 * Copy and Preview resolve the prompt; Preview's Run… dispatches it to any
 * registered agent. The menu's Run dispatches straight to the assembly's
 * runner (Kelpie AI) with no dialog, and only when AI can run now.
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
  managed_by: null,
  settings_path: null,
  last_run_at: null,
  created_at: '2026-08-01T01:00:00.000Z',
  updated_at: '2026-08-01T01:00:00.000Z',
}

const KELPIE_AI_AGENT = {
  ...AGENT,
  id: 'ag_ai',
  name: 'Kelpie AI',
  endpoint: 'https://kelpie.example.com/v1/public/ai/dispatch',
  managed_by: 'ai',
  settings_path: '/admin/ai',
}

function aiSettings(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    key_mode: 'workspace',
    configured: true,
    enabled: true,
    provider: 'anthropic',
    model: 'claude-opus-5',
    key_source: 'workspace',
    key_hint: 'abcd',
    monthly_limit: null,
    runs_this_month: 0,
    web_search: true,
    ...overrides,
  }
}

function aiRunWire(status: string): Record<string, unknown> {
  return {
    id: 'ai_1',
    agent_run_id: 'run_1',
    task_id: 'company.enrich',
    target_type: 'company',
    target_id: 'com_1',
    status,
    model: 'claude-opus-5',
    output: null,
    operations: null,
    failure_reason: status === 'failed' ? 'The Anthropic API key was rejected.' : null,
    input_tokens: null,
    output_tokens: null,
    created_at: '2026-08-07T01:00:00.000Z',
    updated_at: '2026-08-07T01:00:05.000Z',
  }
}

function runWire(status: string, agentId = 'ag_1'): Record<string, unknown> {
  return {
    id: 'run_1',
    agent_id: agentId,
    task_id: 'company.enrich',
    target_type: 'company',
    target_id: 'com_1',
    status,
    failure_reason: status === 'failed' ? 'agent endpoint answered 500' : null,
    created_at: '2026-08-07T01:00:00.000Z',
    updated_at: '2026-08-07T01:00:00.000Z',
  }
}

interface Recorded {
  readonly posts: { path: string; body: unknown }[]
}

interface RenderOptions {
  readonly runStatus?: string
  /** Registers `aiUi`, so the menu has a runner. Its settings, or undefined for none. */
  readonly ai?: Record<string, unknown>
  readonly aiRunStatus?: string
}

function renderComponent(overrides: RenderOptions = {}): Recorded {
  const recorded: Recorded = { posts: [] }
  const withAi = overrides.ai !== undefined
  const client = stubClient({
    list: (path) => {
      if (path === '/agent-tasks') {
        return { items: TASKS, nextCursor: null }
      }

      if (path === '/agents') {
        return { items: withAi ? [AGENT, KELPIE_AI_AGENT] : [AGENT], nextCursor: null }
      }

      if (path === '/ai/runs' && overrides.aiRunStatus !== undefined) {
        return { items: [aiRunWire(overrides.aiRunStatus)], nextCursor: null }
      }

      throw new Error(`Unexpected list ${path}`)
    },
    post: (path, body) => {
      recorded.posts.push({ path, body })

      if (path.endsWith('/resolve')) {
        return RESOLVED
      }

      if (path.endsWith('/run')) {
        return runWire('queued', (body as { agent_id: string }).agent_id)
      }

      throw new Error(`Unexpected post ${path}`)
    },
    get: (path) => {
      if (path === '/agent-runs/run_1') {
        return runWire(overrides.runStatus ?? 'succeeded')
      }

      if (path === '/ai/settings' && overrides.ai !== undefined) {
        return overrides.ai
      }

      throw new Error(`Unexpected get ${path}`)
    },
  })

  render(
    <ApiProvider
      client={client}
      queryClient={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <UiExtensionProvider extensions={withAi ? registerUiModules([aiUi]) : NO_UI_MODULES}>
        <AgentTasks targetType="company" targetId="com_1" targetLabel="Brightline Health" />
      </UiExtensionProvider>
    </ApiProvider>,
  )

  return recorded
}

async function openMenu(): Promise<void> {
  fireEvent.click(screen.getByRole('button', { name: /Agent/u }))
  await screen.findByText('Enrich company')
}

function firstRunButton(): HTMLButtonElement {
  return screen.getAllByRole('button', { name: 'Run' })[0] as HTMLButtonElement
}

async function openRunPane(): Promise<void> {
  fireEvent.click(screen.getAllByRole('button', { name: 'Preview' })[0] as HTMLElement)
  await screen.findByText(/Resolved for Brightline Health/u)
  fireEvent.click(screen.getByRole('button', { name: 'Run…' }))
  await screen.findByRole('option', { name: 'Local Claude' })
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

  it('dispatches from Preview to the chosen agent and reports the settled status', async () => {
    const recorded = renderComponent()
    await openMenu()
    await openRunPane()

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
    await openRunPane()

    fireEvent.click(screen.getByRole('button', { name: 'Dispatch run' }))

    await waitFor(() => {
      expect(screen.getByText(/agent endpoint answered 500/u)).toBeTruthy()
    })
    expect(screen.getByRole('button', { name: 'Retry run' })).toBeTruthy()
  })

  it('disables Run and says why when the assembly has no runner', async () => {
    renderComponent()
    await openMenu()

    expect(firstRunButton().disabled).toBe(true)
    expect(firstRunButton().title).toMatch(/does not include/u)
  })

  it('disables Run until Kelpie AI has a provider key', async () => {
    renderComponent({ ai: aiSettings({ configured: false, key_source: null, key_hint: null }) })
    await openMenu()

    await waitFor(() => {
      expect(firstRunButton().title).toMatch(/no provider key/u)
    })
    expect(firstRunButton().disabled).toBe(true)
  })

  it('disables Run while Kelpie AI is not enabled', async () => {
    renderComponent({ ai: aiSettings({ enabled: false }) })
    await openMenu()

    await waitFor(() => {
      expect(firstRunButton().title).toMatch(/not enabled/u)
    })
    expect(firstRunButton().disabled).toBe(true)
  })

  it('runs straight on Kelpie AI with no dialog, and reports when it is done', async () => {
    const recorded = renderComponent({ ai: aiSettings(), aiRunStatus: 'succeeded' })
    await openMenu()

    await waitFor(() => {
      expect(firstRunButton().disabled).toBe(false)
    })
    fireEvent.click(firstRunButton())

    expect(await screen.findByText('Done.')).toBeTruthy()
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(recorded.posts).toEqual([
      {
        path: '/agent-tasks/company.enrich/run',
        body: { target_type: 'company', target_id: 'com_1', agent_id: 'ag_ai' },
      },
    ])
  })

  it('shows why a Kelpie AI run failed on the task row', async () => {
    renderComponent({ ai: aiSettings(), aiRunStatus: 'failed' })
    await openMenu()

    await waitFor(() => {
      expect(firstRunButton().disabled).toBe(false)
    })
    fireEvent.click(firstRunButton())

    expect(await screen.findByText(/Failed: The Anthropic API key was rejected\./u)).toBeTruthy()
  })
})
