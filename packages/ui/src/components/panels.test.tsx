import { QueryClient } from '@tanstack/react-query'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it } from 'vitest'

import { ApiProvider } from '../api/ApiProvider.tsx'
import type { ApiClient } from '../api/client.ts'
import { useUpdatePerson } from '../api/resources/people.ts'
import { stubClient } from '../testing/stubClient.ts'
import { ActivitiesPanel } from './ActivitiesPanel.tsx'
import { DecisionsPanel } from './DecisionsPanel.tsx'
import { NotesPanel } from './NotesPanel.tsx'

afterEach(cleanup)

/**
 * The parts of these panels that could show something untrue: who did a thing,
 * and whether a row belongs to the record being looked at.
 *
 * Both panels resolve a member id to a name against the workspace member list,
 * because the API has no include-expansion (`docs/api-reference.md`). Getting
 * that join wrong renders "Unknown" beside real work, which is what these
 * assert against.
 */

const MEMBER = {
  id: 'mem_1',
  user_id: 'usr_1',
  name: 'Ada Lovelace',
  email: 'ada@example.com',
  role: 'owner',
  joined_at: '2026-01-01T00:00:00.000Z',
}

const SESSION = {
  user_id: 'usr_1',
  session_id: 'ses_1',
  workspace_id: 'ws_1',
  role: 'owner',
  email_verified: true,
}

interface Stubs {
  readonly activities?: readonly unknown[]
  readonly notes?: readonly unknown[]
  readonly decisions?: readonly unknown[]
  readonly onPost?: (path: string, body: unknown) => unknown
  readonly onPatch?: (path: string, body: unknown) => unknown
  readonly onDelete?: (path: string) => void
  readonly onList?: (path: string) => void
  /** Answers `GET /search`, for the note editor's `[[` picker. */
  readonly search?: (query: Record<string, unknown> | undefined) => unknown
  /** Overrides `activities` from the second request onwards, for invalidation tests. */
  readonly activitiesAfterRefetch?: readonly unknown[]
}

function panelsClient(stubs: Stubs): ApiClient {
  let activityRequests = 0

  return stubClient({
    get: (path, query) => {
      if (path === '/auth/me') {
        return SESSION
      }

      if (path === '/search' && stubs.search !== undefined) {
        return stubs.search(query)
      }

      throw new Error(`Unexpected get ${path}`)
    },
    list: (path) => {
      stubs.onList?.(path)

      if (path === '/activities') {
        activityRequests += 1
      }

      const laterActivities = activityRequests > 1 ? stubs.activitiesAfterRefetch : undefined
      const items =
        path === '/activities'
          ? (laterActivities ?? stubs.activities ?? [])
          : path === '/notes'
            ? (stubs.notes ?? [])
            : path === '/decisions'
              ? (stubs.decisions ?? [])
              : path === '/workspaces/ws_1/members'
                ? [MEMBER]
                : path === '/people'
                  ? []
                  : undefined

      if (items === undefined) {
        throw new Error(`Unexpected list ${path}`)
      }

      return { items, nextCursor: null }
    },
    post: (path, body) => {
      if (stubs.onPost === undefined) {
        throw new Error(`Unexpected post ${path}`)
      }

      return stubs.onPost(path, body)
    },
    patch: (path, body) => {
      if (stubs.onPatch === undefined) {
        throw new Error(`Unexpected patch ${path}`)
      }

      return stubs.onPatch(path, body)
    },
    delete: (path) => {
      if (stubs.onDelete === undefined) {
        throw new Error(`Unexpected delete ${path}`)
      }

      stubs.onDelete(path)
    },
  })
}

function renderWithClient(client: ApiClient, element: React.JSX.Element): void {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })

  // The router is real because DecisionsPanel links to the workspace list.
  render(
    <MemoryRouter>
      <ApiProvider client={client} queryClient={queryClient}>
        {element}
      </ApiProvider>
    </MemoryRouter>,
  )
}

function activity(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'act_1',
    target_type: 'person',
    target_id: 'per_1',
    target_name: null,
    kind: 'created',
    actor_member_id: 'mem_1',
    actor_label: null,
    action: 'created Person',
    detail: null,
    references: [],
    created_at: '2026-08-01T00:00:00.000Z',
    ...overrides,
  }
}

function decision(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'dec_1',
    target_type: 'person',
    target_id: 'per_1',
    body: 'We will not build a favour ledger.',
    rationale: null,
    decided_at: '2026-08-01T00:00:00.000Z',
    owner_id: 'mem_1',
    due_at: null,
    created_at: '2026-08-01T00:00:00.000Z',
    updated_at: '2026-08-01T00:00:00.000Z',
    ...overrides,
  }
}

function note(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'note_1',
    target_type: 'person',
    target_id: 'per_1',
    body: 'Cares about implementation.',
    author_id: 'mem_1',
    pinned: false,
    references: [],
    created_at: '2026-08-01T00:00:00.000Z',
    updated_at: '2026-08-01T00:00:00.000Z',
    ...overrides,
  }
}

describe('ActivitiesPanel', () => {
  it('names the member behind an activity', async () => {
    renderWithClient(
      panelsClient({ activities: [activity()] }),
      <ActivitiesPanel targetType="person" targetId="per_1" />,
    )

    await screen.findByText('Ada Lovelace')
    await screen.findByText('created Person')
  })

  it('uses the actor label when nothing on the team did it', async () => {
    renderWithClient(
      panelsClient({
        activities: [activity({ actor_member_id: null, actor_label: 'Form' })],
      }),
      <ActivitiesPanel targetType="person" targetId="per_1" />,
    )

    await screen.findByText('Form')
  })

  it('marks a rolled-up row as belonging to another record', async () => {
    renderWithClient(
      panelsClient({
        activities: [
          activity({ id: 'act_2', target_type: 'deal', target_id: 'deal_1', action: 'created Deal' }),
        ],
      }),
      <ActivitiesPanel targetType="person" targetId="per_1" />,
    )

    await screen.findByText('Deal')
  })

  it('names a rolled-up row\'s record and links to it', async () => {
    renderWithClient(
      panelsClient({
        activities: [
          activity({
            id: 'act_2',
            target_type: 'deal',
            target_id: 'deal_1',
            target_name: 'Acme renewal',
            action: 'created Deal',
          }),
        ],
      }),
      <ActivitiesPanel targetType="person" targetId="per_1" />,
    )

    const link = await screen.findByRole('link', { name: 'Acme renewal' })

    expect(link.getAttribute('href')).toBe('/deals/deal_1')
  })

  it('links a record the detail cites by id, labelled with its name', async () => {
    const partnershipId = 'prt_01M1DDZFG3N7TWB3F3X4AV4S96'

    renderWithClient(
      panelsClient({
        activities: [
          activity({
            kind: 'note_added',
            action: 'added a note',
            detail: `Evidence: Partnership ${partnershipId} (alumni network)`,
            references: [
              { target_type: 'partnership', target_id: partnershipId, name: 'Sandbox alumni' },
            ],
          }),
        ],
      }),
      <ActivitiesPanel targetType="person" targetId="per_1" />,
    )

    const link = await screen.findByRole('link', { name: 'Sandbox alumni' })

    expect(link.getAttribute('href')).toBe(`/partnerships/${partnershipId}`)
    expect(link.closest('p')?.textContent).toBe('Evidence: Partnership Sandbox alumni (alumni network)')
  })

  it('does not mark a row filed against the record being looked at', async () => {
    renderWithClient(
      panelsClient({ activities: [activity()] }),
      <ActivitiesPanel targetType="person" targetId="per_1" />,
    )

    await screen.findByText('created Person')
    expect(screen.queryByText('Person')).toBeNull()
  })

  it('says so when there is no history', async () => {
    renderWithClient(
      panelsClient({ activities: [] }),
      <ActivitiesPanel targetType="person" targetId="per_1" />,
    )

    await screen.findByText('No activity yet.')
  })
})

describe('activity after a record is edited', () => {
  /**
   * The bug this covers, found by clicking rather than by a test: editing a
     * person's addresses saved, the server wrote the `updated` activity, and the
   * timeline beside it went on showing the old list because the person resource
   * did not declare `activities` among what its writes invalidate.
   */
  it('refetches the timeline when the record it belongs to is patched', async () => {
    const person = {
      id: 'per_1',
      name: 'Ada Lovelace',
      email: null,
      phones: [],
      social_profiles: [],
      timezone: null,
      addresses: [],
      preferred_channel: 'email',
      influence: 'influencer',
      relationship: 'cold',
      summary: '',
      tags: [],
      last_contacted_at: null,
      created_at: '2026-08-01T00:00:00.000Z',
      updated_at: '2026-08-01T00:00:00.000Z',
    }

    function EditsAPerson(): React.JSX.Element {
      const update = useUpdatePerson()

      return (
        <div>
          <button
            type="button"
            onClick={() => {
              update.run({
                id: 'per_1',
                changes: {
                  addresses: [
                    {
                      kind: 'home',
                      line1: null,
                      line2: null,
                      city: 'Melbourne',
                      region: null,
                      postalCode: null,
                      country: 'AU',
                      primary: true,
                    },
                  ],
                },
              })
            }}
          >
            edit
          </button>
          <ActivitiesPanel targetType="person" targetId="per_1" />
        </div>
      )
    }

    renderWithClient(
      panelsClient({
        activities: [activity()],
        activitiesAfterRefetch: [
          activity(),
          activity({ id: 'act_2', kind: 'updated', action: 'changed Location' }),
        ],
        onPatch: () => person,
      }),
      <EditsAPerson />,
    )

    await screen.findByText('created Person')

    await act(async () => {
      screen.getByRole('button', { name: 'edit' }).click()
    })

    await waitFor(() => {
      expect(screen.getByText('changed Location')).toBeTruthy()
    })
  })
})

describe('NotesPanel', () => {
  it('names the author', async () => {
    renderWithClient(
      panelsClient({ notes: [note()] }),
      <NotesPanel targetType="person" targetId="per_1" />,
    )

    await screen.findByText('Cares about implementation.')
    await screen.findByText('Ada Lovelace')
  })

  it('links a record the body cites by id, labelled with its name', async () => {
    const companyId = 'com_01M1DDZFG3N7TWB3F3X4AV4S97'

    renderWithClient(
      panelsClient({
        notes: [
          note({
            body: `Parent is ${companyId}, see \`${companyId}\``,
            references: [{ target_type: 'company', target_id: companyId, name: 'Sandbox Inc' }],
          }),
        ],
      }),
      <NotesPanel targetType="person" targetId="per_1" />,
    )

    const link = await screen.findByRole('link', { name: 'Sandbox Inc' })

    expect(link.getAttribute('href')).toBe(`/companies/${companyId}`)
    // Code is literal: the id inside backticks stays as written.
    expect(screen.getByText(companyId).tagName).toBe('CODE')
  })

  it('links a [[type:id|Label]] token by the name the server gives, not its label', async () => {
    const pageId = 'hb_01M1DDZFG3N7TWB3F3X4AV4S97'

    renderWithClient(
      panelsClient({
        notes: [
          note({
            body: `Read [[handbook_page:${pageId}|Old title]] and [[company:com_gone|Gone Corp]] first`,
            references: [{ target_type: 'handbook_page', target_id: pageId, name: 'How we sell' }],
          }),
        ],
      }),
      <NotesPanel targetType="person" targetId="per_1" />,
    )

    const link = await screen.findByRole('link', { name: 'How we sell' })

    expect(link.getAttribute('href')).toBe(`/handbook/${pageId}`)
    expect(screen.queryByText(/Old title/u)).toBeNull()
    // A record that no longer resolves keeps its label, without the brackets.
    expect(screen.getByText(/Gone Corp first/u).textContent).not.toContain('[[')
    expect(screen.queryByRole('link', { name: 'Gone Corp' })).toBeNull()
  })

  it('links a cited note to the page of the record it is on, at the note', async () => {
    const citedId = 'note_01M1DDZFG3N7TWB3F3X4AV4S97'

    renderWithClient(
      panelsClient({
        notes: [
          note({
            body: `See ${citedId}`,
            references: [
              {
                target_type: 'note',
                target_id: citedId,
                name: 'Pricing call',
                parent_type: 'company',
                parent_id: 'com_1',
              },
            ],
          }),
        ],
      }),
      <NotesPanel targetType="person" targetId="per_1" />,
    )

    const link = await screen.findByRole('link', { name: 'Pricing call' })

    expect(link.getAttribute('href')).toBe(`/companies/com_1#${citedId}`)
  })

  it('highlights the note the address points at', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })

    render(
      <MemoryRouter initialEntries={['/people/per_1#note_2']}>
        <ApiProvider
          client={panelsClient({
            notes: [note({ id: 'note_1', body: 'Other' }), note({ id: 'note_2', body: 'The one' })],
          })}
          queryClient={queryClient}
        >
          <NotesPanel targetType="person" targetId="per_1" />
        </ApiProvider>
      </MemoryRouter>,
    )

    await screen.findByText('The one')

    const target = document.getElementById('note_2')
    const other = document.getElementById('note_1')

    await waitFor(() => {
      expect(target?.className).toContain('ring-2')
    })
    expect(other?.className).not.toContain('ring-2')
  })

  it('reads a null author as the workspace key that wrote it', async () => {
    renderWithClient(
      panelsClient({ notes: [note({ author_id: null })] }),
      <NotesPanel targetType="person" targetId="per_1" />,
    )

    await screen.findByText('API key')
  })

  it('sorts pinned notes above the rest', async () => {
    renderWithClient(
      panelsClient({
        notes: [
          note({ id: 'note_1', body: 'Newer, unpinned' }),
          note({ id: 'note_2', body: 'Older, pinned', pinned: true }),
        ],
      }),
      <NotesPanel targetType="person" targetId="per_1" />,
    )

    await screen.findByText('Older, pinned')

    const bodies = screen.getAllByText(/pinned$/u).map((element) => element.textContent)

    expect(bodies[0]).toBe('Older, pinned')
  })

  it('offers no way to pin, matching the mockup', async () => {
    renderWithClient(
      panelsClient({ notes: [note()] }),
      <NotesPanel targetType="person" targetId="per_1" />,
    )

    await screen.findByText('Cares about implementation.')

    expect(screen.queryByRole('button', { name: /pin/iu })).toBeNull()
  })

  it('renders markdown in a note body', async () => {
    renderWithClient(
      panelsClient({ notes: [note({ body: '**Bold** note' })] }),
      <NotesPanel targetType="person" targetId="per_1" />,
    )

    const bold = await screen.findByText('Bold')

    expect(bold.tagName).toBe('STRONG')
  })

  it('posts a new note to the record it is showing', async () => {
    const posted: { path?: string; body?: unknown } = {}
    const client = panelsClient({
      notes: [],
      onPost: (path, body) => {
        posted.path = path
        posted.body = body

        return note({ body: 'Written just now' })
      },
    })

    renderWithClient(client, <NotesPanel targetType="person" targetId="per_1" />)

    await screen.findByText('No notes yet.')

    await act(async () => {
      screen.getByRole('button', { name: 'Add note' }).click()
    })

    const textarea = screen.getByPlaceholderText(/^Write a note…/u)

    await act(async () => {
      Object.getOwnPropertyDescriptor(
        globalThis.HTMLTextAreaElement.prototype,
        'value',
      )?.set?.call(textarea, 'Written just now')
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })

    await act(async () => {
      screen.getByRole('button', { name: 'Save note' }).click()
    })

    await waitFor(() => {
      expect(posted.path).toBe('/notes')
    })

    expect(posted.body).toEqual({
      target_type: 'person',
      target_id: 'per_1',
      body: 'Written just now',
    })
  })

  it('links a record picked after typing [[, and saves it as a token', async () => {
    const posted: { body?: unknown } = {}
    const searched: unknown[] = []
    const client = panelsClient({
      notes: [],
      search: (query) => {
        searched.push(query?.q)

        return {
          query: 'acm',
          limit: 10,
          total: 2,
          groups: [
            {
              type: 'decision',
              total: 1,
              items: [
                { id: 'dec_1', title: 'Acme pricing', subtitle: null, snippet: '', target_type: 'company', target_id: 'com_1' },
              ],
            },
            { type: 'company', total: 1, items: [{ id: 'com_1', title: 'Acme | Corp', subtitle: 'acme.test', snippet: '' }] },
          ],
        }
      },
      onPost: (_path, body) => {
        posted.body = body

        return note({ body: 'saved' })
      },
    })

    renderWithClient(client, <NotesPanel targetType="person" targetId="per_1" />)

    await screen.findByText('No notes yet.')

    await act(async () => {
      screen.getByRole('button', { name: 'Add note' }).click()
    })

    const textarea = screen.getByPlaceholderText(/^Write a note…/u)

    await act(async () => {
      Object.getOwnPropertyDescriptor(
        globalThis.HTMLTextAreaElement.prototype,
        'value',
      )?.set?.call(textarea, 'Met [[acm')
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })

    const option = await screen.findByRole('option', { name: /Acme \| Corp/u })

    // A decision is offered too: it opens on the record it is on.
    expect(screen.getByRole('option', { name: /Acme pricing/u })).not.toBeNull()
    expect(searched).toContain('acm')

    await act(async () => {
      option.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))
    })

    expect((textarea as HTMLTextAreaElement).value).toBe('Met [[company:com_1|Acme Corp]]')
    expect(screen.queryByRole('listbox')).toBeNull()

    await act(async () => {
      screen.getByRole('button', { name: 'Save note' }).click()
    })

    await waitFor(() => {
      expect(posted.body).toEqual({
        target_type: 'person',
        target_id: 'per_1',
        body: 'Met [[company:com_1|Acme Corp]]',
      })
    })
  })

  it('does not open the picker for @, which is kept for members', async () => {
    renderWithClient(panelsClient({ notes: [] }), <NotesPanel targetType="person" targetId="per_1" />)

    await screen.findByText('No notes yet.')

    await act(async () => {
      screen.getByRole('button', { name: 'Add note' }).click()
    })

    const textarea = screen.getByPlaceholderText(/^Write a note…/u)

    await act(async () => {
      Object.getOwnPropertyDescriptor(
        globalThis.HTMLTextAreaElement.prototype,
        'value',
      )?.set?.call(textarea, 'Ask @ada and [[x]] done')
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })

    expect(screen.queryByRole('listbox')).toBeNull()
  })

  it('patches a note when its body is edited', async () => {
    const patched: { path?: string; body?: unknown } = {}
    const client = panelsClient({
      notes: [note()],
      onPatch: (path, body) => {
        patched.path = path
        patched.body = body

        return note({ body: 'Updated body' })
      },
    })

    renderWithClient(client, <NotesPanel targetType="person" targetId="per_1" />)

    await screen.findByText('Cares about implementation.')

    await act(async () => {
      screen.getByRole('button', { name: 'Edit' }).click()
    })

    const textarea = screen.getByDisplayValue('Cares about implementation.')

    await act(async () => {
      Object.getOwnPropertyDescriptor(
        globalThis.HTMLTextAreaElement.prototype,
        'value',
      )?.set?.call(textarea, 'Updated body')
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })

    await act(async () => {
      screen.getByRole('button', { name: 'Save' }).click()
    })

    await waitFor(() => {
      expect(patched.path).toBe('/notes/note_1')
    })

    expect(patched.body).toEqual({ body: 'Updated body' })
  })

  it('deletes a note only after confirmation', async () => {
    const deleted: string[] = []
    const client = panelsClient({
      notes: [note()],
      onDelete: (path) => {
        deleted.push(path)
      },
    })

    renderWithClient(client, <NotesPanel targetType="person" targetId="per_1" />)

    await screen.findByText('Cares about implementation.')

    await act(async () => {
      screen.getByRole('button', { name: 'Delete' }).click()
    })

    expect(deleted).toEqual([])

    await act(async () => {
      screen.getByRole('button', { name: 'Delete note' }).click()
    })

    await waitFor(() => {
      expect(deleted).toEqual(['/notes/note_1'])
    })
  })

  it('does not delete when confirmation is cancelled', async () => {
    const deleted: string[] = []
    const client = panelsClient({
      notes: [note()],
      onDelete: (path) => {
        deleted.push(path)
      },
    })

    renderWithClient(client, <NotesPanel targetType="person" targetId="per_1" />)

    await screen.findByText('Cares about implementation.')

    await act(async () => {
      screen.getByRole('button', { name: 'Delete' }).click()
    })

    await act(async () => {
      screen.getAllByRole('button', { name: 'Cancel' })[0]?.click()
    })

    expect(deleted).toEqual([])
    expect(screen.getByRole('button', { name: 'Delete' })).toBeTruthy()
  })
})

describe('DecisionsPanel', () => {
  it('names the owner and the moments beside a decision', async () => {
    renderWithClient(
      panelsClient({ decisions: [decision({ due_at: '2026-09-01T00:00:00.000Z' })] }),
      <DecisionsPanel targetType="person" targetId="per_1" />,
    )

    await screen.findByText('We will not build a favour ledger.')
    await screen.findByText('Ada Lovelace')
    await screen.findByText(/^Decided /u)
    await screen.findByText(/^By /u)
  })

  it('shows nothing for an owner nobody can name', async () => {
    renderWithClient(
      panelsClient({ decisions: [decision({ owner_id: null })] }),
      <DecisionsPanel targetType="person" targetId="per_1" />,
    )

    await screen.findByText('We will not build a favour ledger.')

    expect(screen.queryByText('Unknown')).toBeNull()
    expect(screen.queryByText('API key')).toBeNull()
  })

  it('posts a new decision to the record it is showing', async () => {
    const posted: { path?: string; body?: unknown } = {}
    const client = panelsClient({
      decisions: [],
      onPost: (path, body) => {
        posted.path = path
        posted.body = body

        return decision({ body: 'Decided just now' })
      },
    })

    renderWithClient(client, <DecisionsPanel targetType="person" targetId="per_1" />)

    await screen.findByText('No decisions yet.')

    await act(async () => {
      screen.getByRole('button', { name: 'Add decision' }).click()
    })

    const textarea = screen.getByPlaceholderText('We decided / promised…')

    await act(async () => {
      Object.getOwnPropertyDescriptor(
        globalThis.HTMLTextAreaElement.prototype,
        'value',
      )?.set?.call(textarea, 'Decided just now')
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })

    await act(async () => {
      screen.getByRole('button', { name: 'Add' }).click()
    })

    await waitFor(() => {
      expect(posted.path).toBe('/decisions')
    })

    // No rationale, due date, or owner: blank optional fields stay off the
    // wire, and the owner is the server's default, not the form's claim.
    expect(posted.body).toEqual({
      target_type: 'person',
      target_id: 'per_1',
      body: 'Decided just now',
    })
  })

  it('removes a decision from the record it is showing', async () => {
    const deleted: { path?: string } = {}
    const client = panelsClient({
      decisions: [decision()],
      onDelete: (path) => {
        deleted.path = path
      },
    })

    renderWithClient(client, <DecisionsPanel targetType="person" targetId="per_1" />)

    await screen.findByText('We will not build a favour ledger.')

    await act(async () => {
      screen.getByRole('button', { name: 'Remove' }).click()
    })

    await waitFor(() => {
      expect(deleted.path).toBe('/decisions/dec_1')
    })
  })
})
