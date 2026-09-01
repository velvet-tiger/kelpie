import { QueryClient } from '@tanstack/react-query'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
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

    await waitFor(() => {
      expect(posted.body).toEqual({ name: 'Desktop Claude', kind: 'personal' })
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
