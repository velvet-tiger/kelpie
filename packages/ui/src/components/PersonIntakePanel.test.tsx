import { QueryClient } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ApiProvider } from '../api/ApiProvider.tsx'
import { ApiError } from '../api/client.ts'
import { aiUi } from '../modules/ai.tsx'
import { UiExtensionProvider } from '../registry/UiExtensionProvider.tsx'
import { NO_UI_MODULES, registerUiModules } from '../registry/registry.ts'
import { stubClient } from '../testing/stubClient.ts'
import { PersonIntakePanel } from './PersonIntakePanel.tsx'

afterEach(() => {
  cleanup()
  sessionStorage.clear()
})

/**
 * People's Add from notes. With Kelpie AI ready it is the wizard: notes,
 * confirm, choose, done. Without it, the panel copies the add-person prompt
 * with the notes appended, for the user's own agent.
 *
 * `identify` and `research` start a run on the server, and the wizard reads it
 * every 2 seconds until it settles. The stub answers the first read of the
 * identify run as still running, so the wizard has to poll.
 */

const SAVED_RUN_KEY = 'kelpie.personIntake.run.ws_1.usr_1'

/** A saved run for usr_1, as the wizard writes one. */
function savedRun(fields: Record<string, unknown>): Record<string, unknown> {
  return {
    user_id: 'usr_1',
    run_id: null,
    identify_run_id: null,
    step: 'notes',
    text: '',
    candidate: null,
    existing_person_id: null,
    ...fields,
  }
}

/** Long enough for one 2-second poll and the render after it. */
const POLL_WAIT = { timeout: 5000 }

const SESSION = { user_id: 'usr_1', session_id: 'ses_1', workspace_id: 'ws_1', role: 'owner', email_verified: true }
const WORKSPACE = { id: 'ws_1', name: 'Acme', timezone: 'UTC' }

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
  profile_urls: ['https://linkedin.com/in/danareyes'],
  evidence: 'The email domain matches.',
  confidence: 'high',
  existing_people: [{ id: 'per_old', name: 'Dana R.', email: null }],
}

const RESEARCH = {
  summary: 'Dana Reyes is CTO of Brightline Health.',
  items: [
    { key: 'person', kind: 'person', action: 'create', existing_id: null, fields: { name: 'Dana Reyes', email: 'dana@brightline.health' } },
    { key: 'co1', kind: 'company', action: 'create', existing_id: null, fields: { name: 'Brightline Health', domain: 'brightline.health' } },
    { key: 'pos1', kind: 'position', company_key: 'co1', title: 'CTO' },
    { key: 'note', kind: 'note', body: 'Leads engineering.' },
    { key: 'de1', kind: 'deal', company_key: 'co1', fields: { name: 'Brightline pilot' }, reason: 'Asked for pricing.' },
  ],
  sources: [{ url: 'https://brightline.health/team', title: 'Team' }],
  run_id: 'ai_2',
}

const IDENTIFY = { candidates: [CANDIDATE], question: null, sources: [], run_id: 'ai_1' }

function runBody(runId: string, kind: 'identify' | 'research', status: string, result: unknown): Record<string, unknown> {
  return {
    run_id: runId,
    kind,
    status,
    result,
    failure_reason: null,
    expires_at: status === 'succeeded' ? '2026-10-15T13:00:00.000Z' : null,
  }
}

interface Recorded {
  readonly posts: { path: string; body: unknown }[]
  readonly gets: string[]
}

interface DialogOptions {
  readonly ai: boolean
  readonly settings?: Record<string, unknown>
  /** Answers a read of a run, instead of the default identify and research runs. */
  readonly readRun?: (runId: string) => unknown
}

function renderDialog(options: DialogOptions): Recorded {
  const recorded: Recorded = { posts: [], gets: [] }
  let identifyReads = 0
  const client = stubClient({
    get: (path) => {
      recorded.gets.push(path)
      if (path === '/auth/me') return SESSION
      if (path === '/workspaces/ws_1') return WORKSPACE
      if (path === '/ai/settings') return options.settings ?? AI_SETTINGS
      const runId = /^\/ai\/person-intake\/runs\/(?<id>.+)$/u.exec(path)?.groups?.id
      if (runId !== undefined && options.readRun !== undefined) return options.readRun(runId)
      if (runId === 'ai_1') {
        identifyReads += 1
        return identifyReads === 1 ? runBody('ai_1', 'identify', 'running', null) : runBody('ai_1', 'identify', 'succeeded', IDENTIFY)
      }
      if (runId === 'ai_2') return runBody('ai_2', 'research', 'succeeded', RESEARCH)
      throw new Error(`Unexpected get ${path}`)
    },
    list: (path) => {
      if (path === '/agents') return { items: [KELPIE_AI_AGENT], nextCursor: null }
      throw new Error(`Unexpected list ${path}`)
    },
    post: (path, body) => {
      recorded.posts.push({ path, body })

      if (path === '/agent-tasks/workspace.add_person/resolve') {
        return {
          task_id: 'workspace.add_person',
          target_type: 'workspace',
          target_id: 'ws_1',
          prompt: '# Agent task: Add a person from notes',
          context: {
            target_label: 'Acme',
            deep_link: '/',
            handbook_slugs: [],
            pinned_note_ids: [],
            open_plan_ids: [],
            open_decision_ids: [],
            related: {},
          },
        }
      }
      if (path === '/ai/person-intake/identify') return { run_id: 'ai_1' }
      if (path === '/ai/person-intake/research') return { run_id: 'ai_2' }
      if (path === '/ai/person-intake/apply') {
        return {
          results: [
            { key: 'co1', kind: 'company', status: 'created', id: 'com_1', label: 'Brightline Health', detail: null },
            { key: 'person', kind: 'person', status: 'created', id: 'per_1', label: 'Dana Reyes', detail: null },
            { key: 'pos1', kind: 'position', status: 'updated', id: 'pos_1', label: 'CTO at Brightline Health', detail: null },
            { key: 'note', kind: 'note', status: 'created', id: 'not_1', label: 'Research note', detail: null },
          ],
        }
      }
      throw new Error(`Unexpected post ${path}`)
    },
  })

  render(
    <MemoryRouter>
      <ApiProvider client={client} queryClient={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <UiExtensionProvider extensions={options.ai ? registerUiModules([aiUi]) : NO_UI_MODULES}>
          <PersonIntakePanel onClose={() => undefined} onPendingChange={() => undefined} />
        </UiExtensionProvider>
      </ApiProvider>
    </MemoryRouter>,
  )

  return recorded
}

async function typeNotes(text: string): Promise<void> {
  fireEvent.change(await screen.findByLabelText(/^What do you know/u), { target: { value: text } })
}

describe('PersonIntakePanel', () => {
  it('copies the add-person prompt with the notes when no module provides the wizard', async () => {
    const writeText = vi.fn(() => Promise.resolve())
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    const recorded = renderDialog({ ai: false })

    expect(screen.getByText('The AI module is not part of this install.')).toBeTruthy()
    await typeNotes('Dana Reyes, dana@brightline.health')
    await waitFor(() => {
      expect((screen.getByRole('button', { name: 'Copy prompt for your agent' }) as HTMLButtonElement).disabled).toBe(false)
    })
    fireEvent.click(screen.getByRole('button', { name: 'Copy prompt for your agent' }))

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith(
        '# Agent task: Add a person from notes\n\n## Notes about the person\n\nDana Reyes, dana@brightline.health\n',
      )
    })
    expect(recorded.posts[0]).toEqual({
      path: '/agent-tasks/workspace.add_person/resolve',
      body: { target_type: 'workspace', target_id: 'ws_1' },
    })
  })

  it('falls back to the prompt, with the reason, while Kelpie AI is not enabled', async () => {
    renderDialog({ ai: true, settings: { ...AI_SETTINGS, enabled: false } })

    expect(await screen.findByText(/Custom provider is not enabled/u)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Copy prompt for your agent' })).toBeTruthy()
  })

  it('identifies, confirms, and creates only what is ticked', async () => {
    const recorded = renderDialog({ ai: true })

    await typeNotes('Dana Reyes, dana@brightline.health')
    fireEvent.click(await screen.findByRole('button', { name: 'Find this person' }))

    // The run is saved for a reload while it works.
    await waitFor(() => {
      expect(JSON.parse(sessionStorage.getItem(SAVED_RUN_KEY) ?? 'null')).toMatchObject({ run_id: 'ai_1', step: 'notes' })
    })

    // Confirm, after the poll finds the run settled: the candidate, and the existing record it may be.
    expect(await screen.findByText('CTO at Brightline Health', {}, POLL_WAIT)).toBeTruthy()
    expect(recorded.gets.filter((path) => path === '/ai/person-intake/runs/ai_1').length).toBeGreaterThanOrEqual(2)
    expect(screen.getByText('This may already be in Kelpie.')).toBeTruthy()
    fireEvent.click(screen.getByLabelText('Create a new person'))
    fireEvent.click(screen.getByRole('button', { name: 'This is them: research' }))

    await waitFor(() => {
      expect(recorded.posts.map((post) => post.path)).toContain('/ai/person-intake/research')
    })
    const researchPost = recorded.posts.find((post) => post.path === '/ai/person-intake/research')
    expect(researchPost?.body).toMatchObject({ text: 'Dana Reyes, dana@brightline.health', existing_person_id: null })

    // Choose: the deal starts unticked; unticking the company takes the position with it.
    expect(await screen.findByText('Dana Reyes is CTO of Brightline Health.')).toBeTruthy()
    expect(screen.getByText('Why: Asked for pricing.')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Create 4 items' })).toBeTruthy()

    const company = screen.getByRole('checkbox', { name: /^Company Brightline Health/u })
    fireEvent.click(company)
    expect(screen.getByRole('button', { name: 'Create 2 items' })).toBeTruthy()
    fireEvent.click(company)

    fireEvent.click(screen.getByRole('button', { name: 'Create 4 items' }))

    // Done: every written item, with a link.
    expect(await screen.findByText('Done. Kelpie wrote these records.')).toBeTruthy()
    const applyPost = recorded.posts.find((post) => post.path === '/ai/person-intake/apply')
    const applied = applyPost === undefined ? [] : (applyPost.body as { items: { key: string }[] }).items
    expect(applied.map((item) => item.key)).toEqual([
      'person',
      'co1',
      'pos1',
      'note',
    ])
    expect(screen.getByRole('link', { name: 'Brightline Health' }).getAttribute('href')).toBe('/companies/com_1')
    expect(screen.getByRole('link', { name: 'CTO at Brightline Health' }).getAttribute('href')).toBe('/people/per_1')
    expect(screen.getByRole('link', { name: 'Open Dana Reyes' }).getAttribute('href')).toBe('/people/per_1')
    // Done ends the saved run.
    expect(sessionStorage.getItem(SAVED_RUN_KEY)).toBeNull()
  }, 10_000)

  it('picks a saved run up again on the saved step after a reload', async () => {
    sessionStorage.setItem(
      SAVED_RUN_KEY,
      JSON.stringify({
        user_id: 'usr_1',
        identify_run_id: null,
        run_id: 'ai_2',
        step: 'confirm',
        text: 'Dana Reyes, dana@brightline.health',
        candidate: CANDIDATE,
        existing_person_id: null,
      }),
    )
    const recorded = renderDialog({ ai: true })

    // The research run settled while the page was gone: the Choose step shows its result.
    expect(await screen.findByText('Dana Reyes is CTO of Brightline Health.')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Create 4 items' })).toBeTruthy()
    expect(recorded.posts).toEqual([])
    expect(JSON.parse(sessionStorage.getItem(SAVED_RUN_KEY) ?? 'null')).toMatchObject({ run_id: 'ai_2', step: 'choose' })
  })

  it('shows the Confirm step, still working, for a research run that has not settled', async () => {
    sessionStorage.setItem(
      SAVED_RUN_KEY,
      JSON.stringify({ user_id: 'usr_1', identify_run_id: null, run_id: 'ai_2', step: 'confirm', text: 'Dana', candidate: CANDIDATE, existing_person_id: 'per_old' }),
    )
    renderDialog({ ai: true, readRun: (runId) => runBody(runId, 'research', 'running', null) })

    expect(await screen.findByRole('button', { name: 'Researching…' })).toBeTruthy()
    expect(screen.getByText('Dana Reyes')).toBeTruthy()
  })

  it('says the result has gone, with the notes still filled in, for a run the server no longer has', async () => {
    sessionStorage.setItem(
      SAVED_RUN_KEY,
      JSON.stringify({ user_id: 'usr_1', identify_run_id: null, run_id: 'ai_gone', step: 'notes', text: 'Dana Reyes, met at HLTH', candidate: null, existing_person_id: null }),
    )
    renderDialog({
      ai: true,
      readRun: () => {
        throw new ApiError(404, 'not_found', 'No person-intake run has that id')
      },
    })

    expect(await screen.findByText('This result is no longer available. Start again.')).toBeTruthy()
    expect((screen.getByLabelText(/^What do you know/u) as HTMLTextAreaElement).value).toBe('Dana Reyes, met at HLTH')
    expect(sessionStorage.getItem(SAVED_RUN_KEY)).toBeNull()
  })

  it('says the result has gone for a run that succeeded more than an hour ago', async () => {
    sessionStorage.setItem(
      SAVED_RUN_KEY,
      JSON.stringify({ user_id: 'usr_1', identify_run_id: null, run_id: 'ai_old', step: 'confirm', text: 'Dana Reyes', candidate: null, existing_person_id: null }),
    )
    renderDialog({ ai: true, readRun: (runId) => runBody(runId, 'identify', 'succeeded', null) })

    expect(await screen.findByText('This result is no longer available. Start again.')).toBeTruthy()
    expect((screen.getByLabelText(/^What do you know/u) as HTMLTextAreaElement).value).toBe('Dana Reyes')
  })

  it('keeps watching a run it cannot read, starts nothing new, and reads it again on request', async () => {
    sessionStorage.setItem(SAVED_RUN_KEY, JSON.stringify(savedRun({ run_id: 'ai_1', step: 'notes', text: 'Dana Reyes' })))
    let failing = true
    renderDialog({
      ai: true,
      readRun: () => {
        if (failing) throw new ApiError(503, 'service_unreachable', 'Kelpie could not be reached')
        return runBody('ai_1', 'identify', 'succeeded', IDENTIFY)
      },
    })

    expect(await screen.findByText('Kelpie could not be reached')).toBeTruthy()
    // The run goes on at the server, so no second one can start.
    expect((screen.getByRole('button', { name: 'Looking them up…' }) as HTMLButtonElement).disabled).toBe(true)
    expect(JSON.parse(sessionStorage.getItem(SAVED_RUN_KEY) ?? 'null')).toMatchObject({ run_id: 'ai_1' })

    failing = false
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }))

    expect(await screen.findByText('Is this the right person?')).toBeTruthy()
    expect(screen.queryByText('Kelpie could not be reached')).toBeNull()
  })

  it('keeps the step and the notes when research fails, and rebuilds Confirm after a reload', async () => {
    sessionStorage.setItem(SAVED_RUN_KEY, JSON.stringify(savedRun({ run_id: 'ai_1', step: 'confirm', text: 'Dana Reyes' })))
    const readRun = (runId: string): unknown =>
      runId === 'ai_1'
        ? runBody('ai_1', 'identify', 'succeeded', IDENTIFY)
        : { ...runBody(runId, 'research', 'failed', null), failure_reason: 'The model declined this request' }
    renderDialog({ ai: true, readRun })

    fireEvent.click(await screen.findByLabelText('Create a new person'))
    fireEvent.click(screen.getByRole('button', { name: 'This is them: research' }))

    expect(await screen.findByText('The model declined this request', {}, POLL_WAIT)).toBeTruthy()
    expect(JSON.parse(sessionStorage.getItem(SAVED_RUN_KEY) ?? 'null')).toMatchObject({
      run_id: null,
      identify_run_id: 'ai_1',
      step: 'confirm',
      text: 'Dana Reyes',
      candidate: { name: 'Dana Reyes' },
    })

    // A reload: the identify run's result is still kept, so Confirm comes back whole.
    cleanup()
    renderDialog({ ai: true, readRun })

    expect(await screen.findByText('Is this the right person?')).toBeTruthy()
    expect(screen.getByText('This may already be in Kelpie.')).toBeTruthy()
  }, 10_000)

  it('keeps the notes when identify fails, and shows them after a reload', async () => {
    renderDialog({
      ai: true,
      readRun: (runId) => ({ ...runBody(runId, 'identify', 'failed', null), failure_reason: 'The provider is overloaded.' }),
    })

    await typeNotes('Dana Reyes, met at HLTH')
    fireEvent.click(await screen.findByRole('button', { name: 'Find this person' }))
    expect(await screen.findByText('The provider is overloaded.')).toBeTruthy()

    cleanup()
    renderDialog({ ai: true })

    expect(await screen.findByRole('button', { name: 'Find this person' })).toBeTruthy()
    expect((screen.getByLabelText(/^What do you know/u) as HTMLTextAreaElement).value).toBe('Dana Reyes, met at HLTH')
  })

  it('treats saved state it cannot read as no saved run', async () => {
    sessionStorage.setItem(SAVED_RUN_KEY, '{not json')
    renderDialog({ ai: true })

    expect(await screen.findByRole('button', { name: 'Find this person' })).toBeTruthy()
    expect((screen.getByLabelText(/^What do you know/u) as HTMLTextAreaElement).value).toBe('')
  })
})
