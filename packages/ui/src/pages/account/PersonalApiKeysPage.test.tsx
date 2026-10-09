import { QueryClient } from '@tanstack/react-query'
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it } from 'vitest'

import { ApiProvider } from '../../api/ApiProvider.tsx'
import type { ApiClient } from '../../api/client.ts'
import { setInputValue } from '../../testing/inputs.ts'
import { stubClient } from '../../testing/stubClient.ts'
import { PersonalApiKeysPage } from './PersonalApiKeysPage.tsx'

afterEach(cleanup)

/**
 * No role gate here: `GET /v1/api-keys?kind=personal` scopes itself to the
 * caller server-side, so every signed-in member reaches this page directly.
 */

const PERSONAL_KEY = {
  id: 'key_9',
  name: 'Laptop Claude',
  kind: 'personal',
  scopes: [],
  display_prefix: 'kp_user_…7d21',
  last_used_at: '2026-08-10T09:00:00.000Z',
  created_at: '2026-08-01T00:00:00.000Z',
}

interface Stubs {
  readonly keys?: readonly unknown[]
  readonly onPost?: (body: unknown) => unknown
}

function apiKeysClient(stubs: Stubs): ApiClient {
  let stored: readonly Record<string, unknown>[] = (stubs.keys ?? [
    PERSONAL_KEY,
  ]) as readonly Record<string, unknown>[]

  return stubClient({
    list: (path, query) => {
      if (path !== '/api-keys') {
        throw new Error(`Unexpected list ${path}`)
      }

      if (query?.kind !== 'personal') {
        throw new Error(`Expected kind=personal, got ${String(query?.kind)}`)
      }

      return { items: stored, nextCursor: null }
    },
    post: (path, body) => {
      if (stubs.onPost === undefined || path !== '/api-keys') {
        throw new Error(`Unexpected post ${path}`)
      }

      const created = stubs.onPost(body) as Record<string, unknown>
      stored = [created, ...stored]

      return created
    },
    delete: (path) => {
      const match = /^\/api-keys\/(.+)$/u.exec(path)

      if (match === null) {
        throw new Error(`Unexpected delete ${path}`)
      }

      stored = stored.filter((row) => row.id !== match[1])
    },
  })
}

function renderPage(stubs: Stubs = {}): void {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })

  render(
    <MemoryRouter>
      <ApiProvider client={apiKeysClient(stubs)} queryClient={queryClient}>
        <PersonalApiKeysPage />
      </ApiProvider>
    </MemoryRouter>,
  )
}

describe('PersonalApiKeysPage', () => {
  it('lists a personal key with its prefix and last-used date', async () => {
    renderPage()

    expect(await screen.findByText('Laptop Claude')).toBeTruthy()
    expect(screen.getByText('kp_user_…7d21')).toBeTruthy()
  })

  it('shows the secret once after creating a key, and never fetches it again', async () => {
    const posted: { body?: unknown } = {}
    renderPage({
      keys: [],
      onPost: (body) => {
        posted.body = body

        return {
          id: 'key_10',
          name: (body as { name: string }).name,
          kind: 'personal',
          scopes: [],
          display_prefix: 'kp_user_…c3a1',
          last_used_at: null,
          created_at: '2026-08-12T00:00:00.000Z',
          secret: 'kp_user_realsecretvalue',
        }
      },
    })

    await act(async () => {
      screen.getByRole('button', { name: 'Create key' }).click()
    })

    const nameInput = await screen.findByPlaceholderText('Laptop Claude')

    await act(async () => {
      setInputValue(nameInput, 'Desktop Claude')
    })

    await act(async () => {
      screen.getByRole('button', { name: 'Create' }).click()
    })

    // The form opens on the default scopes and sends them by name.
    await waitFor(() => {
      expect(posted.body).toEqual({
        name: 'Desktop Claude',
        kind: 'personal',
        scopes: ['read:objects', 'write:objects'],
      })
    })

    expect(await screen.findByText('kp_user_realsecretvalue')).toBeTruthy()
    expect(screen.getByText(/not shown again/u)).toBeTruthy()

    await act(async () => {
      screen.getByRole('button', { name: 'I have copied it' }).click()
    })

    await waitFor(() => {
      expect(screen.queryByText('kp_user_realsecretvalue')).toBeNull()
    })
  })

  it('offers decisions:commit apart from the presets, and sends it with them', async () => {
    const posted: { body?: unknown } = {}
    renderPage({
      keys: [],
      onPost: (body) => {
        posted.body = body

        return {
          id: 'key_11',
          name: 'Agent',
          kind: 'personal',
          scopes: ['write:objects', 'decisions:commit'],
          display_prefix: 'kp_user_…c3a2',
          last_used_at: null,
          created_at: '2026-08-12T00:00:00.000Z',
          secret: 'kp_user_anothersecret',
        }
      },
    })

    await act(async () => {
      screen.getByRole('button', { name: 'Create key' }).click()
    })
    await act(async () => {
      setInputValue(await screen.findByPlaceholderText('Laptop Claude'), 'Agent')
    })

    const commit = screen.getByRole('checkbox', { name: /^Decisions \(commit without confirmation\)/u })

    // No preset includes it, so it starts clear.
    expect((commit as HTMLInputElement).checked).toBe(false)
    expect(screen.getByText(/is a proposal until a member confirms it/u)).toBeTruthy()

    await act(async () => {
      commit.click()
    })
    await act(async () => {
      screen.getByRole('button', { name: 'Create' }).click()
    })

    await waitFor(() => {
      expect(posted.body).toEqual({
        name: 'Agent',
        kind: 'personal',
        scopes: ['read:objects', 'write:objects', 'decisions:commit'],
      })
    })

    // The list names the extra permission apart; it does not fold it into a count.
    const extras = await screen.findByRole('list', { name: 'Extra permissions' })

    expect(within(extras).getByText('Decisions (commit without confirmation)')).toBeTruthy()
    expect(screen.getByRole('cell', { name: /^Write objects/u })).toBeTruthy()
  })

  it('offers the same extra permissions as the consent page, each with what it risks, and sends the ticked ones', async () => {
    const posted: { body?: unknown } = {}
    renderPage({
      keys: [],
      onPost: (body) => {
        posted.body = body

        return {
          id: 'key_13',
          name: 'Agent',
          kind: 'personal',
          scopes: ['read:objects', 'write:objects', 'handbook:write', 'delete:objects'],
          display_prefix: 'kp_user_…c3a4',
          last_used_at: null,
          created_at: '2026-08-12T00:00:00.000Z',
          secret: 'kp_user_thirdsecret',
        }
      },
    })

    await act(async () => {
      screen.getByRole('button', { name: 'Create key' }).click()
    })
    await act(async () => {
      setInputValue(await screen.findByPlaceholderText('Laptop Claude'), 'Agent')
    })

    // In the section, not in the grid under the presets, which only shows what they include.
    const box = (name: RegExp): HTMLInputElement =>
      within(screen.getByRole('group', { name: 'Extra permissions' })).getByRole('checkbox', { name }) as HTMLInputElement

    for (const name of [/^Decisions \(commit/u, /^Handbook \(write\)/u, /^Delete objects/u]) {
      expect(box(name).checked).toBe(false)
    }

    expect(screen.getByText(/Lets it create and change handbook pages/u)).toBeTruthy()
    expect(screen.getByText('Lets it delete records and handbook pages. A deleted record cannot be restored.')).toBeTruthy()

    await act(async () => {
      box(/^Handbook \(write\)/u).click()
    })
    await act(async () => {
      box(/^Delete objects/u).click()
    })
    await act(async () => {
      screen.getByRole('button', { name: 'Create' }).click()
    })

    await waitFor(() => {
      expect(posted.body).toEqual({
        name: 'Agent',
        kind: 'personal',
        scopes: ['read:objects', 'write:objects', 'handbook:write', 'delete:objects'],
      })
    })

    const extras = await screen.findByRole('list', { name: 'Extra permissions' })

    expect(within(extras).getByText('Handbook (write)')).toBeTruthy()
    expect(within(extras).getByText('Delete objects')).toBeTruthy()
  })

  it('moves a ticked extra into the custom grid, so it has one tick box and not two', async () => {
    renderPage({ keys: [] })

    await act(async () => {
      screen.getByRole('button', { name: 'Create key' }).click()
    })
    await act(async () => {
      within(screen.getByRole('group', { name: 'Extra permissions' }))
        .getByRole('checkbox', { name: /^Handbook \(write\)/u })
        .click()
    })
    await act(async () => {
      screen.getByRole('button', { name: 'Switch to custom scopes…' }).click()
    })

    const handbook = screen.getAllByRole('checkbox', { name: /^Handbook \(write\)/u }) as HTMLInputElement[]

    expect(handbook).toHaveLength(1)
    expect(handbook[0]?.checked).toBe(true)
    expect(handbook[0]?.disabled).toBe(false)
    // The grid has a tick box for each delete scope, so the preset is not offered beside it.
    expect(screen.queryByRole('checkbox', { name: /^Delete objects/u })).toBeNull()
    expect(screen.getByRole('checkbox', { name: /^Decisions \(commit/u })).toBeTruthy()
  })

  it('names the sensitive scopes of a custom key in the list, and marks a full-access key', async () => {
    renderPage({
      keys: [
        { ...PERSONAL_KEY, id: 'key_a', name: 'Custom', scopes: ['people:read', 'deals:read', 'people:delete', 'handbook:write'] },
        { ...PERSONAL_KEY, id: 'key_b', name: 'Wide', scopes: ['read:all', 'write:all'] },
        { ...PERSONAL_KEY, id: 'key_c', name: 'Plain', scopes: ['read:objects', 'write:objects'] },
        { ...PERSONAL_KEY, id: 'key_d', name: 'Everything', scopes: [] },
      ],
    })

    const row = async (name: string): Promise<HTMLElement> => {
      const found = (await screen.findByText(name)).closest('tr')

      if (found === null) {
        throw new Error(`No row for ${name}`)
      }

      return found
    }
    const chips = (within(await row('Custom')).getByRole('list', { name: 'Extra permissions' }).textContent ?? '')

    // The two plain scopes are a count. The two sensitive ones are named.
    expect(within(await row('Custom')).getByText(/Custom \(2 scopes\)/u)).toBeTruthy()
    expect(chips).toContain('People (delete)')
    expect(chips).toContain('Handbook (write)')
    // `write:all` holds the handbook write, and the list says so.
    expect(within(await row('Wide')).getByRole('list', { name: 'Extra permissions' }).textContent).toBe('Handbook (write)')
    expect(within(await row('Plain')).queryByRole('list', { name: 'Extra permissions' })).toBeNull()
    expect(within(await row('Everything')).getByText('Full access')).toBeTruthy()
  })

  it('offers Delete objects as its own choice, which Write objects does not include', async () => {
    renderPage({ keys: [] })

    await act(async () => {
      screen.getByRole('button', { name: 'Create key' }).click()
    })

    // The grid under the presets shows what the ticked presets include, and
    // the form opens with Read objects and Write objects ticked.
    const scope = (name: string): HTMLInputElement => screen.getByRole('checkbox', { name }) as HTMLInputElement

    expect(scope('People (write)').checked).toBe(true)
    expect(scope('People (delete)').checked).toBe(false)
    expect(scope('Handbook (delete)').checked).toBe(false)

    await act(async () => {
      screen.getByRole('checkbox', { name: /^Delete objects/u }).click()
    })

    expect(scope('People (delete)').checked).toBe(true)
    expect(scope('Handbook (delete)').checked).toBe(true)
  })

  it('opens on the default scopes, with full access clear and a warning beside it', async () => {
    renderPage({ keys: [] })

    await act(async () => {
      screen.getByRole('button', { name: 'Create key' }).click()
    })

    const box = (name: string): HTMLInputElement => screen.getByRole('checkbox', { name }) as HTMLInputElement

    expect(box('Read objects').checked).toBe(true)
    expect(box('Write objects').checked).toBe(true)
    expect((screen.getByRole('checkbox', { name: /^Delete objects/u }) as HTMLInputElement).checked).toBe(false)
    expect(box('Admin').checked).toBe(false)
    expect(box('Full access').checked).toBe(false)
    // A personal key acts as its member, who need not be an admin.
    expect(screen.getByText(/A full-access personal key can do everything you can do in this workspace/u)).toBeTruthy()
    expect(screen.queryByText(/manage members, keys and webhooks/u)).toBeNull()
  })

  it('sends full_access only when the person ticks Full access, and no scopes with it', async () => {
    const posted: { body?: unknown } = {}
    renderPage({
      keys: [],
      onPost: (body) => {
        posted.body = body

        return {
          id: 'key_12',
          name: 'Everything',
          kind: 'personal',
          scopes: [],
          display_prefix: 'kp_user_…c3a3',
          last_used_at: null,
          created_at: '2026-08-12T00:00:00.000Z',
          secret: 'kp_user_fullsecret',
        }
      },
    })

    await act(async () => {
      screen.getByRole('button', { name: 'Create key' }).click()
    })
    await act(async () => {
      setInputValue(await screen.findByPlaceholderText('Laptop Claude'), 'Everything')
    })
    await act(async () => {
      screen.getByRole('checkbox', { name: 'Full access' }).click()
    })

    // The scoped choices go away: full access is not a preset among others.
    expect(screen.queryByRole('checkbox', { name: 'Write objects' })).toBeNull()
    expect(screen.queryByRole('checkbox', { name: /^Decisions \(commit/u })).toBeNull()

    await act(async () => {
      screen.getByRole('button', { name: 'Create' }).click()
    })

    await waitFor(() => {
      expect(posted.body).toEqual({ name: 'Everything', kind: 'personal', full_access: true })
    })

    // A key with no scopes reads as full access in the list.
    expect(await screen.findByRole('cell', { name: 'Full access' })).toBeTruthy()
  })

  it('goes back to the default scopes when Full access is cleared', async () => {
    renderPage({ keys: [] })

    await act(async () => {
      screen.getByRole('button', { name: 'Create key' }).click()
    })
    await act(async () => {
      screen.getByRole('checkbox', { name: 'Full access' }).click()
    })
    await act(async () => {
      screen.getByRole('checkbox', { name: 'Full access' }).click()
    })

    expect((screen.getByRole('checkbox', { name: 'Read objects' }) as HTMLInputElement).checked).toBe(true)
    expect((screen.getByRole('checkbox', { name: 'Write objects' }) as HTMLInputElement).checked).toBe(true)
  })

  it('does not create a key with nothing ticked', async () => {
    const posted: unknown[] = []
    renderPage({
      keys: [],
      onPost: (body) => {
        posted.push(body)

        return {}
      },
    })

    await act(async () => {
      screen.getByRole('button', { name: 'Create key' }).click()
    })
    await act(async () => {
      setInputValue(await screen.findByPlaceholderText('Laptop Claude'), 'Nothing')
    })
    await act(async () => {
      screen.getByRole('checkbox', { name: 'Read objects' }).click()
    })
    await act(async () => {
      screen.getByRole('checkbox', { name: 'Write objects' }).click()
    })

    const create = screen.getByRole('button', { name: 'Create' }) as HTMLButtonElement
    const hint = screen.getByText('Choose at least one permission, or full access.')

    expect(create.disabled).toBe(true)
    // The reason is tied to the button for a screen reader.
    expect(create.getAttribute('aria-describedby')).toBe(hint.id)
    expect(hint.id).not.toBe('')
    expect(posted).toEqual([])

    await act(async () => {
      screen.getByRole('checkbox', { name: 'Read objects' }).click()
    })

    expect(create.disabled).toBe(false)
    expect(create.getAttribute('aria-describedby')).toBeNull()
  })

  it('asks before revoking, and removes the key once confirmed', async () => {
    renderPage()

    expect(await screen.findByText('Laptop Claude')).toBeTruthy()

    await act(async () => {
      screen.getByRole('button', { name: 'Revoke' }).click()
    })

    expect(screen.getByText('Laptop Claude')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeTruthy()

    await act(async () => {
      screen.getByRole('button', { name: 'Revoke' }).click()
    })

    await waitFor(() => {
      expect(screen.queryByText('Laptop Claude')).toBeNull()
    })
  })
})
