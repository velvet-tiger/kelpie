import { QueryClient } from '@tanstack/react-query'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it } from 'vitest'

import { ApiProvider } from '../../api/ApiProvider.tsx'
import { ApiError } from '../../api/client.ts'
import type { ApiClient } from '../../api/client.ts'
import { setInputValue } from '../../testing/inputs.ts'
import { stubClient } from '../../testing/stubClient.ts'
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
  return { user_id: 'usr_1', session_id: 'ses_1', workspace_id: 'ws_1', role, email_verified: true }
}

/** One settled delivery, as `GET /v1/webhooks/:id/deliveries` returns it. */
const DELIVERY = {
  id: 'whd_1',
  webhook_id: 'wh_1',
  event: 'record.created',
  payload: {
    id: 'whd_1',
    event: 'record.created',
    created_at: '2026-08-04T05:06:00.000Z',
    workspace_id: 'ws_1',
    data: { object_type: 'person', record_id: 'per_9' },
  },
  status: 'success',
  attempts: 1,
  delivered_at: '2026-08-04T05:06:01.000Z',
  created_at: '2026-08-04T05:06:00.000Z',
}

interface DeliveryRequest {
  readonly status: string | undefined
  readonly cursor: string | undefined
}

interface Stubs {
  readonly role?: string
  readonly webhooks?: readonly unknown[]
  readonly listFails?: ApiError
  readonly onPost?: (body: unknown) => unknown
  readonly onPatch?: (path: string, body: unknown) => unknown
  /** Answers `/webhooks/:id/deliveries`. Absent means the page must never ask. */
  readonly onDeliveries?: (request: DeliveryRequest) => { items: unknown[]; nextCursor: string | null }
  /** Answers `/webhooks/:id/rotate_secret`. */
  readonly onRotate?: (body: unknown) => unknown
}

function webhooksClient(stubs: Stubs): ApiClient {
  // A write is followed by a list invalidation, so the stub has to remember
  // what it was told. A static list would answer the refetch with the row as it
  // was before the request, and the assertion would be about the stub.
  let stored: readonly Record<string, unknown>[] = (stubs.webhooks ?? [
    WEBHOOK,
  ]) as readonly Record<string, unknown>[]

  return stubClient({
    get: (path) => {
      if (path !== '/auth/me') {
        throw new Error(`Unexpected get ${path}`)
      }

      return session(stubs.role ?? 'owner')
    },
    list: (path, query) => {
      if (path === '/webhooks/wh_1/deliveries') {
        if (stubs.onDeliveries === undefined) {
          throw new Error(`Unexpected list ${path}`)
        }

        return stubs.onDeliveries({
          status: query?.status as string | undefined,
          cursor: query?.cursor as string | undefined,
        })
      }

      if (path !== '/webhooks') {
        throw new Error(`Unexpected list ${path}`)
      }

      if (stubs.listFails !== undefined) {
        return Promise.reject(stubs.listFails)
      }

      return { items: stored, nextCursor: null }
    },
    post: (path, body) => {
      if (path === '/webhooks/wh_1/rotate_secret') {
        if (stubs.onRotate === undefined) {
          throw new Error(`Unexpected post ${path}`)
        }

        return stubs.onRotate(body)
      }

      if (stubs.onPost === undefined || path !== '/webhooks') {
        throw new Error(`Unexpected post ${path}`)
      }

      return stubs.onPost(body)
    },
    patch: (path, body) => {
      if (stubs.onPatch === undefined) {
        throw new Error(`Unexpected patch ${path}`)
      }

      const updated = stubs.onPatch(path, body) as Record<string, unknown>
      stored = stored.map((row) => (row.id === updated.id ? updated : row))

      return updated
    },
  })
}

function renderPage(stubs: Stubs = {}): void {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })

  render(
    <MemoryRouter>
      <ApiProvider client={webhooksClient(stubs)} queryClient={queryClient}>
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

/**
 * Replacing a leaked secret without deleting the registration. The choice on
 * offer is a security one, so the page has to be unambiguous about which way
 * the checkbox cuts.
 */
describe('WebhooksPage secret rotation', () => {
  function rotateStubs(): { bodies: unknown[]; stubs: Stubs } {
    const bodies: unknown[] = []

    return {
      bodies,
      stubs: {
        onRotate: (body) => {
          bodies.push(body)

          return { ...WEBHOOK, secret_prefix: 'whsec_…aa11', secret: 'whsec_rotatedvalue' }
        },
      },
    }
  }

  async function openRotatePanel(): Promise<void> {
    const toggle = await screen.findByRole('button', { name: 'Rotate secret' })

    await act(async () => {
      toggle.click()
    })
  }

  /** The panel's own button carries the same label, so this picks the last one. */
  async function confirmRotation(): Promise<void> {
    const buttons = await screen.findAllByRole('button', { name: 'Rotate secret' })

    await act(async () => {
      buttons.at(-1)?.click()
    })
  }

  it('asks nothing until the panel is opened', async () => {
    const { bodies, stubs } = rotateStubs()
    renderPage(stubs)

    await screen.findByText('https://example.com/hooks/kelpie')
    expect(bodies).toHaveLength(0)
  })

  it('rotates without an overlap by default', async () => {
    const { bodies, stubs } = rotateStubs()
    renderPage(stubs)
    await openRotatePanel()
    await confirmRotation()

    await waitFor(() => {
      expect(bodies).toEqual([{ overlap: false }])
    })
  })

  it('sends the overlap when the box is ticked', async () => {
    const { bodies, stubs } = rotateStubs()
    renderPage(stubs)
    await openRotatePanel()

    const overlap = await screen.findByRole('checkbox', { name: /Keep accepting the old secret/u })

    await act(async () => {
      ;(overlap as HTMLInputElement).click()
    })
    await confirmRotation()

    await waitFor(() => {
      expect(bodies).toEqual([{ overlap: true }])
    })
  })

  /** The response is the only place the replacement secret ever appears. */
  it('shows the new secret once, in the same panel a registration uses', async () => {
    const { stubs } = rotateStubs()
    renderPage(stubs)
    await openRotatePanel()
    await confirmRotation()

    expect(await screen.findByText('whsec_rotatedvalue')).toBeTruthy()
    expect(screen.getByText(/not shown again/u)).toBeTruthy()
  })

  /**
   * The default is the tighter answer, and the copy has to say what it costs.
   * A customer rotating a leaked secret needs to know deliveries will fail.
   */
  it('says what each choice does before the button is pressed', async () => {
    const { stubs } = rotateStubs()
    renderPage(stubs)
    await openRotatePanel()

    const overlap = await screen.findByRole('checkbox', { name: /Keep accepting the old secret/u })

    expect((overlap as HTMLInputElement).checked).toBe(false)
    expect(screen.getByText(/keeps its id, its events and its delivery log/u)).toBeTruthy()
    expect(screen.getByText(/stops working immediately/u)).toBeTruthy()
  })
})

/**
 * The row above a delivery log says only when the newest one happened. These
 * cover what it cannot: which event failed, how hard it was tried, and what the
 * receiver was actually sent.
 */
describe('WebhooksPage delivery log', () => {
  function recordingStubs(
    pages: readonly { items: unknown[]; nextCursor: string | null }[],
  ): { requests: DeliveryRequest[]; stubs: Stubs } {
    const requests: DeliveryRequest[] = []

    return {
      requests,
      stubs: {
        onDeliveries: (request) => {
          requests.push(request)

          return pages[requests.length - 1] ?? { items: [], nextCursor: null }
        },
      },
    }
  }

  async function expand(): Promise<void> {
    const toggle = await screen.findByRole('button', { name: 'Deliveries' })

    await act(async () => {
      toggle.click()
    })
  }

  /** Ten registrations must not mean ten delivery requests on page load. */
  it('asks for nothing until the row is expanded', async () => {
    const { requests, stubs } = recordingStubs([{ items: [DELIVERY], nextCursor: null }])
    renderPage(stubs)

    await screen.findByText('https://example.com/hooks/kelpie')
    expect(requests).toHaveLength(0)

    await expand()

    await waitFor(() => {
      expect(requests).toHaveLength(1)
    })
    expect(requests[0]?.status).toBeUndefined()
  })

  it('shows the event, attempt count and outcome of each delivery', async () => {
    const { stubs } = recordingStubs([
      {
        items: [
          { ...DELIVERY, id: 'whd_2', status: 'failed', attempts: 4, delivered_at: null },
          DELIVERY,
        ],
        nextCursor: null,
      },
    ])
    renderPage(stubs)
    await expand()

    expect(await screen.findByText('failed')).toBeTruthy()
    expect(screen.getByText('success')).toBeTruthy()
    // 4 attempts is the engine's whole retry budget, so this row is the one a
    // customer opened the log to find.
    expect(screen.getByText('4')).toBeTruthy()
    // A delivery that never landed has no timestamp to show.
    expect(screen.getByText('—')).toBeTruthy()
  })

  it('says nothing has been delivered rather than showing an empty table', async () => {
    const { stubs } = recordingStubs([{ items: [], nextCursor: null }])
    renderPage(stubs)
    await expand()

    expect(await screen.findByText('Nothing delivered yet.')).toBeTruthy()
  })

  /**
   * The body is stored as `jsonb`, so Postgres reorders its keys. Showing it is
   * how a customer sees what arrived; claiming it is the signed text would send
   * them off to verify an HMAC against a string we never transmitted.
   */
  it('shows the delivery body without claiming it is the signed text', async () => {
    const { stubs } = recordingStubs([{ items: [DELIVERY], nextCursor: null }])
    renderPage(stubs)
    await expand()

    const view = await screen.findByRole('button', { name: 'View' })

    await act(async () => {
      view.click()
    })

    expect(screen.getByText(/object_type/u)).toBeTruthy()
    expect(screen.getByText(/not the exact text the signature was computed over/u)).toBeTruthy()
  })

  it('asks the server for one status rather than filtering the page it has', async () => {
    const { requests, stubs } = recordingStubs([
      { items: [DELIVERY], nextCursor: null },
      { items: [{ ...DELIVERY, id: 'whd_3', status: 'failed', delivered_at: null }], nextCursor: null },
    ])
    renderPage(stubs)
    await expand()

    const failed = await screen.findByRole('button', { name: 'Failed' })

    await act(async () => {
      failed.click()
    })

    await waitFor(() => {
      expect(requests).toHaveLength(2)
    })
    expect(requests[1]?.status).toBe('failed')
  })

  it('pages with the cursor the previous page issued', async () => {
    const { requests, stubs } = recordingStubs([
      { items: [DELIVERY], nextCursor: 'cursor_2' },
      { items: [{ ...DELIVERY, id: 'whd_4' }], nextCursor: null },
    ])
    renderPage(stubs)
    await expand()

    const loadMore = await screen.findByRole('button', { name: 'Load more' })

    await act(async () => {
      loadMore.click()
    })

    await waitFor(() => {
      expect(requests).toHaveLength(2)
    })
    expect(requests[1]?.cursor).toBe('cursor_2')
  })
})
