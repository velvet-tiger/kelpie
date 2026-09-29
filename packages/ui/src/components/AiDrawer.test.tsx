import { QueryClient } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ApiProvider } from '../api/ApiProvider.tsx'
import type { ApiClient } from '../api/client.ts'
import { aiUi } from '../modules/ai.tsx'
import { UiExtensionProvider } from '../registry/UiExtensionProvider.tsx'
import { NO_UI_MODULES, registerUiModules } from '../registry/registry.ts'
import type { UiExtensions } from '../registry/registry.ts'
import { stubClient } from '../testing/stubClient.ts'
import { useAiDrawer } from './aiDrawerState.ts'
import type { AiDrawerTask } from './aiDrawerState.ts'
import { AddFromNotesButton } from './PersonIntakePanel.tsx'
import { personIntakeTask } from './personIntakeTask.tsx'
import { Shell } from './Shell.tsx'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

/**
 * The AI drawer: a task runs beside the page, not over it, and keeps its state
 * while the drawer is hidden and while the user moves between pages.
 */

const SESSION = { user_id: 'usr_1', session_id: 'ses_1', workspace_id: 'ws_1', role: 'owner', email_verified: true }
const ACCOUNT = { id: 'usr_1', email: 'ada@example.com', name: 'Ada Lovelace', email_verified: true }
const PREFERENCES = {
  timezone: 'UTC',
  theme: 'system',
  email_digest: true,
  mention_emails: true,
  product_updates: true,
  list_views: {},
}
const WORKSPACES = [
  { id: 'ws_1', name: 'Acme Labs', timezone: 'UTC', role: 'owner' },
  { id: 'ws_2', name: 'Globex', timezone: 'UTC', role: 'member' },
]
const AI_SETTINGS = {
  service: 'custom',
  key_mode: 'workspace',
  configured: true,
  enabled: true,
  provider: 'anthropic',
  model: 'claude-opus-5',
  key_source: 'workspace',
  key_hint: 'WXYZ',
  monthly_limit: null,
  runs_this_month: 0,
  web_search: true,
}
const KELPIE_AI_AGENT = {
  id: 'ag_ai',
  name: 'Kelpie AI',
  endpoint: 'https://kelpie.example.com/v1/public/ai/dispatch',
  has_auth_header: false,
  managed_by: 'ai',
  settings_path: '/admin/ai',
  last_run_at: null,
  created_at: '2026-08-01T01:00:00.000Z',
  updated_at: '2026-08-01T01:00:00.000Z',
}
const CANDIDATE = {
  key: 'c1',
  name: 'Dana Reyes',
  headline: 'CTO at Brightline Health',
  company_name: 'Brightline Health',
  title: 'CTO',
  location: 'Austin, TX',
  email: 'dana@brightline.health',
  profile_urls: [],
  evidence: 'The email domain matches.',
  confidence: 'high',
  existing_people: [],
}

interface Stubs {
  /** Resolves the pending `identify` request. */
  identify?: Promise<unknown>
}

function shellClient(stubs: Stubs = {}): ApiClient {
  return stubClient({
    get: (path) => {
      if (path === '/auth/me') return SESSION
      if (path === '/account') return ACCOUNT
      if (path === '/account/preferences') return PREFERENCES
      if (path === '/workspaces/ws_1') return { id: 'ws_1', name: 'Acme Labs', timezone: 'UTC' }
      if (path === '/ai/settings') return AI_SETTINGS
      throw new Error(`Unexpected get ${path}`)
    },
    list: (path) => {
      if (path === '/workspaces/ws_1/modules') return { items: [], nextCursor: null }
      if (path === '/auth/workspaces') return { items: WORKSPACES, nextCursor: null }
      if (path === '/agents') return { items: [KELPIE_AI_AGENT], nextCursor: null }
      throw new Error(`Unexpected list ${path}`)
    },
    post: (path, body) => {
      if (path === '/auth/workspace') {
        const record = body !== null && typeof body === 'object' ? (body as Record<string, unknown>) : {}
        return { ...SESSION, workspace_id: record.workspace_id, role: 'member' }
      }
      if (path === '/ai/person-intake/identify' && stubs.identify !== undefined) return stubs.identify
      throw new Error(`Unexpected post ${path}`)
    },
  })
}

/** A task with state of its own, so a test can tell a remount from a hidden panel. */
function counterTask(id = 'counter'): AiDrawerTask {
  return {
    id,
    title: `Counter ${id}`,
    render: (controls) => <Counter onDone={controls.finish} />,
  }
}

function Counter({ onDone }: { readonly onDone: () => void }): React.JSX.Element {
  const [count, setCount] = useState(0)

  return (
    <div>
      <p>Count {count}</p>
      <button
        type="button"
        onClick={() => {
          setCount((current) => current + 1)
        }}
      >
        Increment
      </button>
      <button type="button" onClick={onDone}>
        Done
      </button>
    </div>
  )
}

let lastOpenResult: boolean | undefined

function StartPage({ label }: { readonly label: string }): React.JSX.Element {
  const drawer = useAiDrawer()
  const navigate = useNavigate()

  return (
    <div>
      <p>{label} page</p>
      <button
        type="button"
        onClick={() => {
          lastOpenResult = drawer.open(counterTask('first'))
        }}
      >
        Start first
      </button>
      <button
        type="button"
        onClick={() => {
          lastOpenResult = drawer.open(counterTask('second'))
        }}
      >
        Start second
      </button>
      <AddFromNotesButton
        onClick={() => {
          drawer.open(personIntakeTask())
        }}
      />
      <button
        type="button"
        onClick={() => {
          void navigate(label === 'Dashboard' ? '/companies' : '/dashboard')
        }}
      >
        Go elsewhere
      </button>
    </div>
  )
}

function renderShell(options: { readonly stubs?: Stubs; readonly extensions?: UiExtensions } = {}): void {
  render(
    <ApiProvider
      baseUrl="http://localhost/v1"
      client={shellClient(options.stubs)}
      queryClient={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <UiExtensionProvider extensions={options.extensions ?? NO_UI_MODULES}>
        <MemoryRouter initialEntries={['/dashboard']}>
          <Routes>
            <Route element={<Shell />}>
              <Route path="dashboard" element={<StartPage label="Dashboard" />} />
              <Route path="companies" element={<StartPage label="Companies" />} />
            </Route>
          </Routes>
        </MemoryRouter>
      </UiExtensionProvider>
    </ApiProvider>,
  )
}

function drawer(): HTMLElement | null {
  return document.querySelector('aside[aria-label^="Counter"], aside[aria-label="Add a person from notes"]')
}

async function click(name: string | RegExp): Promise<void> {
  await act(async () => {
    screen.getByRole('button', { name }).click()
  })
}

describe('the AI drawer', () => {
  it('is not rendered until a task opens, and then sits beside the page with no modal', async () => {
    renderShell()
    await screen.findByText('Dashboard page')

    expect(drawer()).toBeNull()

    await click('Start first')

    expect(drawer()?.hidden).toBe(false)
    expect(screen.getByText('Dashboard page')).toBeTruthy()
    expect(document.querySelector('[aria-modal="true"]')).toBeNull()
  })

  it('keeps the task mounted when closed and across a route change', async () => {
    renderShell()
    await screen.findByText('Dashboard page')
    await click('Start first')
    await click('Increment')
    await click('Increment')

    await click('Close')

    expect(drawer()?.hidden).toBe(true)

    await click('Go elsewhere')
    await screen.findByText('Companies page')
    // The header button brings the hidden task back.
    await click('Counter first')

    expect(drawer()?.hidden).toBe(false)
    expect(screen.getByText('Count 2')).toBeTruthy()
  })

  it('unmounts the task when it finishes', async () => {
    renderShell()
    await screen.findByText('Dashboard page')
    await click('Start first')
    await click('Done')

    expect(drawer()).toBeNull()
    expect(screen.queryByRole('button', { name: 'Counter first' })).toBeNull()
  })

  it('does not replace an active task', async () => {
    renderShell()
    await screen.findByText('Dashboard page')
    await click('Start first')
    await click('Increment')
    await click('Close')
    await click('Start second')

    expect(lastOpenResult).toBe(false)
    expect(drawer()?.getAttribute('aria-label')).toBe('Counter first')
    expect(screen.getByText('Count 1')).toBeTruthy()
    expect(screen.getByRole('status').textContent).toContain('Finish or discard this task')
  })

  it('discards the task on a workspace switch', async () => {
    renderShell()
    await screen.findByText('Dashboard page')
    await click('Start first')
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Switch workspace' })).toBeTruthy()
    })
    await click('Switch workspace')
    await act(async () => {
      screen.getByRole('menuitem', { name: /Globex/u }).click()
    })

    await waitFor(() => {
      expect(drawer()).toBeNull()
    })
  })

  it('lets person intake finish while the user works on another page', async () => {
    let resolveIdentify: (value: unknown) => void = () => undefined
    const identify = new Promise<unknown>((resolve) => {
      resolveIdentify = resolve
    })
    renderShell({ stubs: { identify }, extensions: registerUiModules([aiUi]) })
    await screen.findByText('Dashboard page')

    await click(/Add from notes/u)
    fireEvent.change(await screen.findByLabelText(/^What do you know/u), {
      target: { value: 'Dana Reyes, dana@brightline.health' },
    })
    await click('Find this person')

    await click('Close')
    // Working: the header button shows the spinner title.
    expect(screen.getByRole('button', { name: 'Add a person from notes' }).title).toContain('working')

    await click('Go elsewhere')
    await screen.findByText('Companies page')

    await act(async () => {
      resolveIdentify({ candidates: [CANDIDATE], question: null, sources: [], run_id: 'ai_1' })
      await identify
    })

    await click('Add a person from notes')

    expect(await screen.findByText('Dana Reyes')).toBeTruthy()
    expect(screen.getByText('Is this the right person?')).toBeTruthy()
  })
})
