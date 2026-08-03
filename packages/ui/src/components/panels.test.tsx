import { QueryClient } from '@tanstack/react-query'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { ApiProvider } from '../api/ApiProvider.tsx'
import type { ApiClient, QueryParameters } from '../api/client.ts'
import { useUpdatePerson } from '../api/resources/people.ts'
import { ActivitiesPanel } from './ActivitiesPanel.tsx'
import { NotesPanel } from './NotesPanel.tsx'

afterEach(cleanup)

/**
 * The parts of these panels that could show something untrue: who did a thing,
 * and whether a row belongs to the record being looked at.
 *
 * Both panels resolve a member id to a name against the workspace member list,
 * because `api.md` has no include-expansion. Getting that join wrong renders
 * "Unknown" beside real work, which is what these assert against.
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
}

interface Stubs {
  readonly activities?: readonly unknown[]
  readonly notes?: readonly unknown[]
  readonly onPost?: (path: string, body: unknown) => unknown
  readonly onPatch?: (path: string, body: unknown) => unknown
  readonly onList?: (path: string) => void
  /** Overrides `activities` from the second request onwards, for invalidation tests. */
  readonly activitiesAfterRefetch?: readonly unknown[]
}

function stubClient(stubs: Stubs): ApiClient {
  let activityRequests = 0

  return {
    get: (path, decode) => {
      if (path === '/auth/me') {
        return Promise.resolve(decode(SESSION))
      }

      throw new Error(`Unexpected get ${path}`)
    },
    list: (path: string, decodeItem, _query?: QueryParameters) => {
      stubs.onList?.(path)

      if (path === '/activities') {
        activityRequests += 1
      }

      const laterActivities =
        activityRequests > 1 ? stubs.activitiesAfterRefetch : undefined
      const items =
        path === '/activities'
          ? (laterActivities ?? stubs.activities ?? [])
          : path === '/notes'
            ? (stubs.notes ?? [])
            : path === '/workspaces/ws_1/members'
              ? [MEMBER]
              : path === '/people'
                ? []
                : undefined

      if (items === undefined) {
        throw new Error(`Unexpected list ${path}`)
      }

      return Promise.resolve({ items: items.map(decodeItem), nextCursor: null })
    },
    post: (path, body, decode) => {
      if (stubs.onPost === undefined) {
        throw new Error(`Unexpected post ${path}`)
      }

      return Promise.resolve(decode(stubs.onPost(path, body)))
    },
    postEmpty: () => {
      throw new Error('Unexpected postEmpty call')
    },
    patch: (path, body, decode) => {
      if (stubs.onPatch === undefined) {
        throw new Error(`Unexpected patch ${path}`)
      }

      return Promise.resolve(decode(stubs.onPatch(path, body)))
    },
    delete: () => {
      throw new Error('Unexpected delete call')
    },
  }
}

function renderWithClient(client: ApiClient, element: React.JSX.Element): void {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })

  render(
    <ApiProvider client={client} queryClient={queryClient}>
      {element}
    </ApiProvider>,
  )
}

function activity(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'act_1',
    target_type: 'person',
    target_id: 'per_1',
    kind: 'created',
    actor_member_id: 'mem_1',
    actor_label: null,
    action: 'created Person',
    detail: null,
    created_at: '2026-08-01T00:00:00.000Z',
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
    created_at: '2026-08-01T00:00:00.000Z',
    updated_at: '2026-08-01T00:00:00.000Z',
    ...overrides,
  }
}

describe('ActivitiesPanel', () => {
  it('names the member behind an activity', async () => {
    renderWithClient(
      stubClient({ activities: [activity()] }),
      <ActivitiesPanel targetType="person" targetId="per_1" />,
    )

    await screen.findByText('Ada Lovelace')
    await screen.findByText('created Person')
  })

  it('uses the actor label when nothing on the team did it', async () => {
    renderWithClient(
      stubClient({
        activities: [activity({ actor_member_id: null, actor_label: 'Form' })],
      }),
      <ActivitiesPanel targetType="person" targetId="per_1" />,
    )

    await screen.findByText('Form')
  })

  it('marks a rolled-up row as belonging to another record', async () => {
    renderWithClient(
      stubClient({
        activities: [
          activity({ id: 'act_2', target_type: 'deal', target_id: 'deal_1', action: 'created Deal' }),
        ],
      }),
      <ActivitiesPanel targetType="person" targetId="per_1" />,
    )

    await screen.findByText('Deal')
  })

  it('does not mark a row filed against the record being looked at', async () => {
    renderWithClient(
      stubClient({ activities: [activity()] }),
      <ActivitiesPanel targetType="person" targetId="per_1" />,
    )

    await screen.findByText('created Person')
    expect(screen.queryByText('Person')).toBeNull()
  })

  it('says so when there is no history', async () => {
    renderWithClient(
      stubClient({ activities: [] }),
      <ActivitiesPanel targetType="person" targetId="per_1" />,
    )

    await screen.findByText('No activity yet.')
  })
})

describe('activity after a record is edited', () => {
  /**
   * The bug this covers, found by clicking rather than by a test: editing a
   * person's location saved, the server wrote the `updated` activity, and the
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
      location: 'Melbourne',
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
              update.run({ id: 'per_1', changes: { location: 'Melbourne' } })
            }}
          >
            edit
          </button>
          <ActivitiesPanel targetType="person" targetId="per_1" />
        </div>
      )
    }

    renderWithClient(
      stubClient({
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
      stubClient({ notes: [note()] }),
      <NotesPanel targetType="person" targetId="per_1" />,
    )

    await screen.findByText('Cares about implementation.')
    await screen.findByText('Ada Lovelace')
  })

  it('reads a null author as the workspace key that wrote it', async () => {
    renderWithClient(
      stubClient({ notes: [note({ author_id: null })] }),
      <NotesPanel targetType="person" targetId="per_1" />,
    )

    await screen.findByText('API key')
  })

  it('sorts pinned notes above the rest', async () => {
    renderWithClient(
      stubClient({
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
      stubClient({ notes: [note()] }),
      <NotesPanel targetType="person" targetId="per_1" />,
    )

    await screen.findByText('Cares about implementation.')

    expect(screen.queryByRole('button', { name: /pin/iu })).toBeNull()
  })

  it('posts a new note to the record it is showing', async () => {
    const posted: { path?: string; body?: unknown } = {}
    const client = stubClient({
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

    const textarea = screen.getByPlaceholderText('Write a note…')

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
})
