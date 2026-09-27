import { QueryClient } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ApiProvider } from '../api/ApiProvider.tsx'
import { aiUi } from '../modules/ai.tsx'
import { UiExtensionProvider } from '../registry/UiExtensionProvider.tsx'
import { NO_UI_MODULES, registerUiModules } from '../registry/registry.ts'
import { stubClient } from '../testing/stubClient.ts'
import { PersonIntakeDialog } from './PersonIntakeDialog.tsx'

afterEach(cleanup)

/**
 * People's Add from notes. With Kelpie AI ready it is the wizard: notes,
 * confirm, choose, done. Without it, the dialog copies the add-person prompt
 * with the notes appended, for the user's own agent.
 */

const SESSION = { user_id: 'usr_1', session_id: 'ses_1', workspace_id: 'ws_1', role: 'owner', email_verified: true }
const WORKSPACE = { id: 'ws_1', name: 'Acme', timezone: 'UTC' }

const AI_SETTINGS = {
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

interface Recorded {
  readonly posts: { path: string; body: unknown }[]
}

function renderDialog(options: { readonly ai: boolean; readonly settings?: Record<string, unknown> }): Recorded {
  const recorded: Recorded = { posts: [] }
  const client = stubClient({
    get: (path) => {
      if (path === '/auth/me') return SESSION
      if (path === '/workspaces/ws_1') return WORKSPACE
      if (path === '/ai/settings') return options.settings ?? AI_SETTINGS
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
      if (path === '/ai/person-intake/identify') {
        return { candidates: [CANDIDATE], question: null, sources: [], run_id: 'ai_1' }
      }
      if (path === '/ai/person-intake/research') return RESEARCH
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
          <PersonIntakeDialog onClose={() => undefined} />
        </UiExtensionProvider>
      </ApiProvider>
    </MemoryRouter>,
  )

  return recorded
}

async function typeNotes(text: string): Promise<void> {
  fireEvent.change(await screen.findByLabelText(/^What do you know/u), { target: { value: text } })
}

describe('PersonIntakeDialog', () => {
  it('copies the add-person prompt with the notes when no module provides the wizard', async () => {
    const writeText = vi.fn(() => Promise.resolve())
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    const recorded = renderDialog({ ai: false })

    expect(screen.getByText('Kelpie AI is not part of this install.')).toBeTruthy()
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

    expect(await screen.findByText(/Kelpie AI is not enabled/u)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Copy prompt for your agent' })).toBeTruthy()
  })

  it('identifies, confirms, and creates only what is ticked', async () => {
    const recorded = renderDialog({ ai: true })

    await typeNotes('Dana Reyes, dana@brightline.health')
    fireEvent.click(await screen.findByRole('button', { name: 'Find this person' }))

    // Confirm: the candidate, and the existing record it may be.
    expect(await screen.findByText('CTO at Brightline Health')).toBeTruthy()
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
  })
})
