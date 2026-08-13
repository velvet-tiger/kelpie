import { QueryClient } from '@tanstack/react-query'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it } from 'vitest'

import { ApiProvider } from '../../api/ApiProvider.tsx'
import { ApiError } from '../../api/client.ts'
import type { ApiClient } from '../../api/client.ts'
import { setInputValue } from '../../testing/inputs.ts'
import { stubClient } from '../../testing/stubClient.ts'
import { ApiKeysPage } from './ApiKeysPage.tsx'

afterEach(cleanup)

/**
 * The three things this page can get wrong in a way a reader would believe:
 * showing a member an empty list instead of saying it is not theirs to see,
 * losing the one response that ever carries the secret, and revoking a key
 * with one accidental click.
 */

const WORKSPACE_KEY = {
  id: 'key_1',
  name: 'CI pipeline',
  kind: 'workspace',
  display_prefix: 'kp_live_…9f2c',
  last_used_at: null,
  created_at: '2026-08-01T00:00:00.000Z',
}

function session(role: string): Record<string, unknown> {
  return { user_id: 'usr_1', session_id: 'ses_1', workspace_id: 'ws_1', role, email_verified: true }
}

interface Stubs {
  readonly role?: string
  readonly keys?: readonly unknown[]
  readonly listFails?: ApiError
  readonly onPost?: (body: unknown) => unknown
}

function apiKeysClient(stubs: Stubs): ApiClient {
  // A write is followed by a list invalidation, so the stub has to remember
  // what it was told, the same reason `webhooksClient` does.
  let stored: readonly Record<string, unknown>[] = (stubs.keys ?? [
    WORKSPACE_KEY,
  ]) as readonly Record<string, unknown>[]

  return stubClient({
    get: (path) => {
      if (path !== '/auth/me') {
        throw new Error(`Unexpected get ${path}`)
      }

      return session(stubs.role ?? 'owner')
    },
    list: (path, query) => {
      if (path !== '/api-keys') {
        throw new Error(`Unexpected list ${path}`)
      }

      if (query?.kind !== 'workspace') {
        throw new Error(`Expected kind=workspace, got ${String(query?.kind)}`)
      }

      if (stubs.listFails !== undefined) {
        return Promise.reject(stubs.listFails)
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
        <ApiKeysPage />
      </ApiProvider>
    </MemoryRouter>,
  )
}

describe('ApiKeysPage', () => {
  it('tells a member workspace keys are not theirs to manage', async () => {
    renderPage({ role: 'member', keys: [] })

    expect(await screen.findByText(/managed by workspace admins/u)).toBeTruthy()
    expect(screen.queryByText('Create key')).toBeNull()
  })

  it('lists a key with its prefix and last-used date', async () => {
    renderPage()

    expect(await screen.findByText('CI pipeline')).toBeTruthy()
    expect(screen.getByText('kp_live_…9f2c')).toBeTruthy()
    expect(screen.getByText('Never')).toBeTruthy()
  })

  it('shows the secret once after creating a key, and never fetches it again', async () => {
    const posted: { body?: unknown } = {}
    renderPage({
      keys: [],
      onPost: (body) => {
        posted.body = body

        return {
          id: 'key_2',
          name: (body as { name: string }).name,
          kind: 'workspace',
          display_prefix: 'kp_live_…ab12',
          last_used_at: null,
          created_at: '2026-08-12T00:00:00.000Z',
          secret: 'kp_live_realsecretvalue',
        }
      },
    })

    const createButton = await screen.findByRole('button', { name: 'Create key' })

    await act(async () => {
      createButton.click()
    })

    const nameInput = await screen.findByPlaceholderText('CI pipeline')

    await act(async () => {
      setInputValue(nameInput, 'Release bot')
    })

    await act(async () => {
      screen.getByRole('button', { name: 'Create' }).click()
    })

    await waitFor(() => {
      expect(posted.body).toEqual({ name: 'Release bot', kind: 'workspace' })
    })

    expect(await screen.findByText('kp_live_realsecretvalue')).toBeTruthy()
    expect(screen.getByText(/not shown again/u)).toBeTruthy()

    await act(async () => {
      screen.getByRole('button', { name: 'I have copied it' }).click()
    })

    await waitFor(() => {
      expect(screen.queryByText('kp_live_realsecretvalue')).toBeNull()
    })
  })

  it('asks before revoking, and removes the key once confirmed', async () => {
    renderPage()

    expect(await screen.findByText('CI pipeline')).toBeTruthy()

    await act(async () => {
      screen.getByRole('button', { name: 'Revoke' }).click()
    })

    // The click above only opens the confirm step; nothing is deleted yet.
    expect(screen.getByText('CI pipeline')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeTruthy()

    await act(async () => {
      screen.getByRole('button', { name: 'Revoke' }).click()
    })

    await waitFor(() => {
      expect(screen.queryByText('CI pipeline')).toBeNull()
    })
  })

  it('says why the list could not be read', async () => {
    renderPage({ listFails: new ApiError(403, 'forbidden', 'This action needs the admin role', []) })

    expect(await screen.findByText(/admin role|not available/u)).toBeTruthy()
  })
})
