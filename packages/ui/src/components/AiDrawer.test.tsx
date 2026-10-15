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
  vi.unstubAllGlobals()
  sessionStorage.clear()
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

const IDENTIFIED = { candidates: [CANDIDATE], question: null, sources: [], run_id: 'ai_1' }

interface Stubs {
  /** Answers each read of the identify run. Defaults to a run that has settled. */
  readRun?: () => unknown
}

function identifyRun(status: string, result: unknown): Record<string, unknown> {
  return {
    run_id: 'ai_1',
    kind: 'identify',
    status,
    result,
    failure_reason: null,
    expires_at: status === 'succeeded' ? '2026-10-15T13:00:00.000Z' : null,
  }
}

function shellClient(stubs: Stubs = {}): ApiClient {
  // The session follows a switch, as the server's does.
  let session: Record<string, unknown> = SESSION

  return stubClient({
    get: (path) => {
      if (path === '/auth/me') return session
      if (path === '/account') return ACCOUNT
      if (path === '/account/preferences') return PREFERENCES
      if (path === '/workspaces/ws_1') return { id: 'ws_1', name: 'Acme Labs', timezone: 'UTC' }
      if (path === '/workspaces/ws_2') return { id: 'ws_2', name: 'Globex', timezone: 'UTC' }
      if (path === '/ai/settings') return AI_SETTINGS
      if (path.startsWith('/ai/person-intake/runs/')) {
        return stubs.readRun === undefined ? identifyRun('succeeded', IDENTIFIED) : stubs.readRun()
      }
      throw new Error(`Unexpected get ${path}`)
    },
    list: (path) => {
      if (path === '/workspaces/ws_1/modules' || path === '/workspaces/ws_2/modules') return { items: [], nextCursor: null }
      if (path === '/auth/workspaces') return { items: WORKSPACES, nextCursor: null }
      if (path === '/agents') return { items: [KELPIE_AI_AGENT], nextCursor: null }
      throw new Error(`Unexpected list ${path}`)
    },
    post: (path, body) => {
      if (path === '/auth/workspace') {
        const record = body !== null && typeof body === 'object' ? (body as Record<string, unknown>) : {}
        session = { ...SESSION, workspace_id: record.workspace_id, role: 'member' }
        return session
      }
      if (path === '/ai/person-intake/identify') return { run_id: 'ai_1' }
      throw new Error(`Unexpected post ${path}`)
    },
  })
}

/** A saved intake run for usr_1 waiting on the Confirm step, as the wizard writes one. */
function savedIntake(runId: string): Record<string, unknown> {
  return {
    user_id: 'usr_1',
    run_id: runId,
    identify_run_id: null,
    step: 'confirm',
    text: 'Dana Reyes',
    candidate: null,
    existing_person_id: null,
  }
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

  it('restores the new workspace\'s saved intake run on a switch, and clears only the old one', async () => {
    vi.stubGlobal('confirm', () => true)
    sessionStorage.setItem('kelpie.personIntake.run.ws_1.usr_1', JSON.stringify(savedIntake('ai_1')))
    sessionStorage.setItem('kelpie.personIntake.run.ws_2.usr_1', JSON.stringify(savedIntake('ai_1')))
    renderShell({ extensions: registerUiModules([aiUi]) })
    await screen.findByText('Dashboard page')
    // Workspace 1's run is the active task, in the header.
    await screen.findByRole('button', { name: 'Add a person from notes' })

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Switch workspace' })).toBeTruthy()
    })
    await click('Switch workspace')
    await act(async () => {
      screen.getByRole('menuitem', { name: /Globex/u }).click()
    })

    // The old task ended and cleared its own workspace's run. Workspace 2's
    // run was found once the drawer was free, and waits closed in the header.
    await waitFor(() => {
      expect(sessionStorage.getItem('kelpie.personIntake.run.ws_1.usr_1')).toBeNull()
    })
    expect(sessionStorage.getItem('kelpie.personIntake.run.ws_2.usr_1')).not.toBeNull()
    expect(await screen.findByRole('button', { name: 'Add a person from notes' })).toBeTruthy()
    expect(drawer()?.hidden).toBe(true)
  })

  it('deletes a saved intake run another user left in the tab, and does not restore it', async () => {
    sessionStorage.setItem(
      'kelpie.personIntake.run.ws_1.usr_2',
      JSON.stringify({ ...savedIntake('ai_1'), user_id: 'usr_2', text: 'Someone else\'s notes' }),
    )
    renderShell({ extensions: registerUiModules([aiUi]) })
    await screen.findByText('Dashboard page')

    await waitFor(() => {
      expect(sessionStorage.getItem('kelpie.personIntake.run.ws_1.usr_2')).toBeNull()
    })
    expect(screen.queryByRole('button', { name: 'Add a person from notes' })).toBeNull()
    expect(drawer()).toBeNull()
  })

  it('lets person intake finish while the user works on another page', async () => {
    let settled = false
    const readRun = (): unknown => (settled ? identifyRun('succeeded', IDENTIFIED) : identifyRun('running', null))
    renderShell({ stubs: { readRun }, extensions: registerUiModules([aiUi]) })
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

    // The next poll finds the run settled.
    settled = true
    await waitFor(
      () => {
        expect(screen.getByRole('button', { name: 'Add a person from notes' }).title).not.toContain('working')
      },
      { timeout: 5000 },
    )

    await click('Add a person from notes')

    expect(await screen.findByText('Dana Reyes')).toBeTruthy()
    expect(screen.getByText('Is this the right person?')).toBeTruthy()
  }, 10_000)

  it('finds a saved intake run after a reload, with the drawer closed', async () => {
    sessionStorage.setItem(
      'kelpie.personIntake.run.ws_1.usr_1',
      JSON.stringify({ user_id: 'usr_1', identify_run_id: null, run_id: 'ai_1', step: 'confirm', text: 'Dana Reyes', candidate: null, existing_person_id: null }),
    )
    renderShell({ extensions: registerUiModules([aiUi]) })
    await screen.findByText('Dashboard page')

    // The page stays uncovered: the task is in the header, the drawer hidden.
    const launcher = await screen.findByRole('button', { name: 'Add a person from notes' })
    expect(drawer()?.hidden).toBe(true)

    await click('Add a person from notes')
    expect(launcher.isConnected).toBe(false)
    expect(await screen.findByText('Is this the right person?')).toBeTruthy()
  })

  it('forgets the saved intake run when the task is discarded', async () => {
    sessionStorage.setItem(
      'kelpie.personIntake.run.ws_1.usr_1',
      JSON.stringify({ user_id: 'usr_1', identify_run_id: null, run_id: 'ai_1', step: 'confirm', text: 'Dana Reyes', candidate: null, existing_person_id: null }),
    )
    renderShell({ extensions: registerUiModules([aiUi]) })
    await screen.findByRole('button', { name: 'Add a person from notes' })
    await click('Add a person from notes')
    await screen.findByText('Is this the right person?')
    // Discard asks first while a request may still be pending; this test is about what it clears.
    vi.stubGlobal('confirm', () => true)

    await click('Discard')

    expect(drawer()).toBeNull()
    expect(sessionStorage.getItem('kelpie.personIntake.run.ws_1.usr_1')).toBeNull()
  })
})
