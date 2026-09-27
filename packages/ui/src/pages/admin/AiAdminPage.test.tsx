import { QueryClient } from '@tanstack/react-query'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it } from 'vitest'

import { ApiProvider } from '../../api/ApiProvider.tsx'
import { setInputValue } from '../../testing/inputs.ts'
import { stubClient } from '../../testing/stubClient.ts'
import { aiUi } from '../../modules/ai.tsx'
import { registerUiModules } from '../../registry/registry.ts'
import type { UiModule } from '../../registry/registry.ts'
import { UiExtensionProvider } from '../../registry/UiExtensionProvider.tsx'
import { AiAdminPage } from './AiAdminPage.tsx'

afterEach(cleanup)

/**
 * What this page can get wrong in a way a reader would believe: sending a key
 * the admin did not type, showing a key it should only hint at, offering a key
 * form where the deployment owns the key, and hiding why a run failed.
 */

function settings(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    key_mode: 'workspace',
    configured: false,
    enabled: false,
    provider: null,
    model: '',
    key_source: null,
    key_hint: null,
    monthly_limit: null,
    runs_this_month: 0,
    web_search: true,
    ...overrides,
  }
}

const FAILED_RUN = {
  id: 'ai_1',
  agent_run_id: 'run_1',
  task_id: 'person.enrich',
  target_type: 'person',
  target_id: 'per_1',
  target_name: 'Ada Lovelace',
  status: 'failed',
  model: 'claude-opus-5',
  operations: null,
  failure_reason: 'The Anthropic API key was rejected. Check the key in AI settings.',
  input_tokens: null,
  output_tokens: null,
  created_at: '2026-09-20T01:00:00.000Z',
  updated_at: '2026-09-20T01:00:05.000Z',
}

const NOTE_ID = 'note_01M3FYKBGF5BZ0C2SN5E97VQAK'

const APPLIED_RUN = {
  ...FAILED_RUN,
  id: 'ai_2',
  task_id: 'company.account_brief',
  target_type: 'company',
  target_id: 'com_1',
  target_name: 'Acme',
  status: 'succeeded',
  failure_reason: null,
  operations: [
    {
      kind: 'append_note',
      status: 'applied',
      detail: `Created note ${NOTE_ID}`,
      references: [
        { target_type: 'note', target_id: NOTE_ID, name: 'Acme sells to…', parent_type: 'company', parent_id: 'com_1' },
      ],
    },
  ],
}

const WORKSPACE_RUN = {
  ...FAILED_RUN,
  id: 'ai_3',
  task_id: 'person_intake.research',
  target_type: 'workspace',
  target_id: 'ws_01M1DDZF4C4QW2W2NW3K2XV0C5',
  target_name: null,
  status: 'succeeded',
  failure_reason: null,
}

interface PageStubs {
  readonly settings?: Record<string, unknown>
  readonly runs?: readonly unknown[]
  readonly onPost?: (body: unknown) => Record<string, unknown>
  /** The UI modules the assembly lists. The `ai` module unless a test says otherwise. */
  readonly modules?: readonly UiModule[]
  readonly path?: string
}

function renderPage(stubs: PageStubs = {}): void {
  let current = stubs.settings ?? settings()
  const client = stubClient({
    get: (path) => {
      if (path !== '/ai/settings') {
        // The timezone lookup; the page falls back without it.
        throw new Error(`Unexpected get ${path}`)
      }

      return current
    },
    list: (path) => {
      if (path !== '/ai/runs') {
        throw new Error(`Unexpected list ${path}`)
      }

      return { items: stubs.runs ?? [], nextCursor: null }
    },
    post: (path, body) => {
      if (path !== '/ai/settings' || stubs.onPost === undefined) {
        throw new Error(`Unexpected post ${path}`)
      }

      current = stubs.onPost(body)
      return current
    },
  })

  render(
    <MemoryRouter initialEntries={[stubs.path ?? '/admin/ai']}>
      <ApiProvider
        client={client}
        queryClient={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}
      >
        <UiExtensionProvider extensions={registerUiModules(stubs.modules ?? [aiUi])}>
          <AiAdminPage />
        </UiExtensionProvider>
      </ApiProvider>
    </MemoryRouter>,
  )
}

describe('AiAdminPage', () => {
  it('sends the provider and the key the admin typed, then hints at the key without showing it', async () => {
    const posted: unknown[] = []
    renderPage({
      onPost: (body) => {
        posted.push(body)
        return settings({
          configured: true,
          enabled: true,
          provider: 'anthropic',
          model: 'claude-opus-5',
          key_source: 'workspace',
          key_hint: 'WXYZ',
        })
      },
    })

    const provider = (await screen.findByLabelText(/^Provider/u)) as HTMLSelectElement
    act(() => {
      provider.value = 'anthropic'
      provider.dispatchEvent(new Event('change', { bubbles: true }))
    })
    act(() => {
      setInputValue(screen.getByLabelText(/^API key/u), 'sk-ant-workspace-key-WXYZ')
    })
    act(() => {
      screen.getByRole('button', { name: 'Enable AI' }).click()
    })

    await waitFor(() => {
      expect(posted).toEqual([{ provider: 'anthropic', api_key: 'sk-ant-workspace-key-WXYZ' }])
    })
    expect(await screen.findByText(/Your key ending in WXYZ is stored/u)).toBeTruthy()
    expect(screen.queryByDisplayValue('sk-ant-workspace-key-WXYZ')).toBeNull()
    expect(screen.getByRole('button', { name: 'Disable AI' })).toBeTruthy()
  })

  it('sends only what changed when saving a new model', async () => {
    const posted: unknown[] = []
    const enabled = settings({
      configured: true,
      enabled: true,
      provider: 'openai',
      model: 'gpt-5-mini',
      key_source: 'workspace',
      key_hint: 'ABCD',
    })
    renderPage({
      settings: enabled,
      onPost: (body) => {
        posted.push(body)
        return { ...enabled, model: 'gpt-5' }
      },
    })

    const model = await screen.findByLabelText(/^Model/u)
    act(() => {
      setInputValue(model, 'gpt-5')
    })
    act(() => {
      screen.getByRole('button', { name: 'Save' }).click()
    })

    await waitFor(() => {
      expect(posted).toEqual([{ model: 'gpt-5' }])
    })
  })

  it('offers no key form when the deployment owns the key, and says what to set', async () => {
    renderPage({ settings: settings({ key_mode: 'deployment' }) })

    expect(await screen.findByText('AI_API_KEY')).toBeTruthy()
    expect(screen.queryByLabelText(/^API key/u)).toBeNull()
  })

  it('shows why a run failed', async () => {
    renderPage({ runs: [FAILED_RUN] })
    act(() => {
      screen.getByRole('tab', { name: 'Run log' }).click()
    })

    expect(await screen.findByText('The Anthropic API key was rejected. Check the key in AI settings.')).toBeTruthy()
    expect(screen.getByText('person.enrich')).toBeTruthy()
  })

  it('links each run to its record and each cited record, and leaves the workspace id out', async () => {
    renderPage({ runs: [APPLIED_RUN, WORKSPACE_RUN] })
    act(() => {
      screen.getByRole('tab', { name: 'Run log' }).click()
    })

    expect((await screen.findByRole('link', { name: 'Acme' })).getAttribute('href')).toBe('/companies/com_1')
    expect(screen.getByRole('link', { name: 'Acme sells to…' }).getAttribute('href')).toBe(`/companies/com_1#${NOTE_ID}`)
    expect(screen.getByText('person_intake.research')).toBeTruthy()
    expect(screen.queryByText(/ws_01M1DDZF4C4QW2W2NW3K2XV0C5/u)).toBeNull()
  })

  it('opens on Settings, with MCP after the module tabs', async () => {
    renderPage({})

    expect(await screen.findByText('Kelpie AI')).toBeTruthy()
    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['Settings', 'Run log', 'MCP'])
    expect(screen.getByRole('tab', { name: 'Settings' }).getAttribute('aria-selected')).toBe('true')
  })

  it('shows only the core MCP tab when the assembly lists no ai module', () => {
    renderPage({ modules: [] })

    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['MCP'])
    expect(screen.getByText('Streamable HTTP endpoint')).toBeTruthy()
  })

  it('opens the tab ?tab= names, which is where /admin/mcp redirects', () => {
    renderPage({ path: '/admin/ai?tab=mcp' })

    expect(screen.getByRole('tab', { name: 'MCP' }).getAttribute('aria-selected')).toBe('true')
    expect(screen.getByText('Streamable HTTP endpoint')).toBeTruthy()
  })
})
