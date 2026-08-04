import { QueryClient } from '@tanstack/react-query'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it } from 'vitest'

import { ApiProvider } from '../../api/ApiProvider.tsx'
import { ApiError } from '../../api/client.ts'
import type { ApiClient } from '../../api/client.ts'
import { WebhooksPage } from './WebhooksPage.tsx'

afterEach(cleanup)

/**
 * The three things this page can get wrong in a way a reader would believe:
 * showing a member an empty list instead of saying it is not theirs to see,
 * losing the one response that ever carries the signing secret, and offering a
 * status the API refuses.
 */

const WEBHOOK = {
  id: 'wh_1',
  url: 'https://example.com/hooks/kelpie',
  events: ['record.created'],
  secret_prefix: 'whsec_…9f2c',
  status: 'active',
  last_delivery_at: null,
  last_delivery_status: null,
  created_at: '2026-08-01T00:00:00.000Z',
  updated_at: '2026-08-01T00:00:00.000Z',
}

function session(role: string): Record<string, unknown> {
  return { user_id: 'usr_1', session_id: 'ses_1', workspace_id: 'ws_1', role }
}

interface Stubs {
  readonly role?: string
  readonly webhooks?: readonly unknown[]
  readonly listFails?: ApiError
  readonly onPost?: (body: unknown) => unknown
  readonly onPatch?: (path: string, body: unknown) => unknown
}

function stubClient(stubs: Stubs): ApiClient {
  const unexpected = (what: string): never => {
    throw new Error(`Unexpected ${what}`)
  }

  // A write is followed by a list invalidation, so the stub has to remember
  // what it was told. A static list would answer the refetch with the row as it
  // was before the request, and the assertion would be about the stub.
  let stored: readonly Record<string, unknown>[] = (stubs.webhooks ?? [
    WEBHOOK,
  ]) as readonly Record<string, unknown>[]

  return {
    get: (path, decode) =>
      path === '/auth/me'
        ? Promise.resolve(decode(session(stubs.role ?? 'owner')))
        : unexpected(`get ${path}`),
    list: (path, decodeItem) => {
      if (path !== '/webhooks') {
        return unexpected(`list ${path}`)
      }

      if (stubs.listFails !== undefined) {
        return Promise.reject(stubs.listFails)
      }

      return Promise.resolve({ items: stored.map(decodeItem), nextCursor: null })
    },
    post: (path, body, decode) =>
      stubs.onPost === undefined || path !== '/webhooks'
        ? unexpected(`post ${path}`)
        : Promise.resolve(decode(stubs.onPost(body))),
    patch: (path, body, decode) => {
      if (stubs.onPatch === undefined) {
        return unexpected(`patch ${path}`)
      }

      const updated = stubs.onPatch(path, body) as Record<string, unknown>
      stored = stored.map((row) => (row.id === updated.id ? updated : row))

      return Promise.resolve(decode(updated))
    },
    delete: () => unexpected('delete'),
    getText: () => unexpected('getText'),
    postForm: () => unexpected('postForm'),
    postEmpty: () => unexpected('postEmpty'),
    patchEmpty: () => unexpected('patchEmpty'),
  }
}

/** React tracks the value on the node, so a plain assignment is not seen. */
function setInputValue(input: HTMLElement, value: string): void {
  Object.getOwnPropertyDescriptor(globalThis.HTMLInputElement.prototype, 'value')?.set?.call(
    input,
    value,
  )
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

function renderPage(stubs: Stubs = {}): void {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })

  render(
    <MemoryRouter>
      <ApiProvider client={stubClient(stubs)} queryClient={queryClient}>
        <WebhooksPage />
      </ApiProvider>
    </MemoryRouter>,
  )
}

describe('WebhooksPage', () => {
  it('lists a registration with its events, secret prefix and status', async () => {
    renderPage()

    expect(await screen.findByText('https://example.com/hooks/kelpie')).toBeTruthy()
    // Twice: once as the row's subscription chip, once as a form checkbox.
    expect(screen.getAllByText('record.created')).toHaveLength(2)
    expect(screen.getByText('Secret whsec_…9f2c')).toBeTruthy()
    expect(screen.getByText('Active')).toBeTruthy()
    expect(screen.getByText('Last delivery: Never')).toBeTruthy()
  })

  it('reports a delivery that has happened', async () => {
    renderPage({
      webhooks: [
        {
          ...WEBHOOK,
          status: 'failing',
          last_delivery_at: '2026-08-04T05:06:00.000Z',
          last_delivery_status: 'failed',
        },
      ],
    })

    expect(await screen.findByText('Failing')).toBeTruthy()
    expect(screen.getByText(/Last delivery: .*\(failed\)/u)).toBeTruthy()
  })

  /**
   * A member's list request answers `403`, so rendering the table would show an
   * empty list where the truth is that it is not theirs to read. The page never
   * asks: the stub would throw on an unexpected call if it did.
   */
  it('tells a member the list is not theirs rather than showing an empty one', async () => {
    renderPage({ role: 'member', webhooks: [] })

    expect(await screen.findByText(/managed by workspace admins/u)).toBeTruthy()
    expect(screen.queryByText('Add webhook')).toBeNull()
  })

  it('shows the signing secret once after registering, and never fetches it again', async () => {
    const posted: { body?: unknown } = {}
    renderPage({
      onPost: (body) => {
        posted.body = body

        return { ...WEBHOOK, ...(body as object), secret: 'whsec_realsecretvalue' }
      },
    })

    const url = await screen.findByPlaceholderText('https://example.com/webhooks/kelpie')

    await act(async () => {
      setInputValue(url, 'https://example.com/hooks/kelpie')
    })

    await act(async () => {
      screen.getByRole('button', { name: 'Add webhook' }).click()
    })

    await waitFor(() => {
      expect(posted.body).toEqual({
        url: 'https://example.com/hooks/kelpie',
        events: ['record.created'],
      })
    })

    expect(await screen.findByText('whsec_realsecretvalue')).toBeTruthy()
    expect(screen.getByText(/not shown again/u)).toBeTruthy()

    await act(async () => {
      screen.getByRole('button', { name: 'I have copied it' }).click()
    })

    await waitFor(() => {
      expect(screen.queryByText('whsec_realsecretvalue')).toBeNull()
    })
  })

  it('refuses to submit with no events selected', async () => {
    renderPage()

    const checkbox = (await screen.findAllByRole('checkbox')).at(0)

    await act(async () => {
      ;(checkbox as HTMLInputElement).click()
    })

    expect(screen.getByRole('button', { name: 'Add webhook' }).hasAttribute('disabled')).toBe(true)
  })

  /** `failing` is the engine's report, so the only control is pause and resume. */
  it('pauses a webhook, and offers resume rather than a status it cannot set', async () => {
    const patched: { path?: string; body?: unknown } = {}

    renderPage({
      onPatch: (path, body) => {
        patched.path = path
        patched.body = body

        return { ...WEBHOOK, status: 'paused' }
      },
    })

    const pause = await screen.findByRole('button', { name: 'Pause' })

    await act(async () => {
      pause.click()
    })

    await waitFor(() => {
      expect(patched.path).toBe('/webhooks/wh_1')
    })
    expect(patched.body).toEqual({ status: 'paused' })
    expect(await screen.findByRole('button', { name: 'Resume' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Failing/u })).toBeNull()
  })

  it('says why the list could not be read', async () => {
    renderPage({ listFails: new ApiError(403, 'forbidden', 'This action needs the admin role', []) })

    expect(await screen.findByText(/admin role|not available/u)).toBeTruthy()
  })
})
