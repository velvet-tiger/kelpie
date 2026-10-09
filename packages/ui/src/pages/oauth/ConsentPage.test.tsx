import { QueryClient } from '@tanstack/react-query'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ApiProvider } from '../../api/ApiProvider.tsx'
import { ApiError } from '../../api/client.ts'
import { stubClient } from '../../testing/stubClient.ts'
import { ConsentPage } from './ConsentPage.tsx'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

/**
 * What the consent page can get wrong in a way a person would act on: losing
 * the request across sign-in, hiding where the browser will be sent, and
 * approving more than the person left ticked: more access, or more workspaces.
 */

const REQUEST = {
  id: 'oar_1',
  client_name: 'Example Agent',
  client_host: 'client.example',
  client_uri: null,
  logo_uri: null,
  scopes: ['read:objects', 'write:objects'],
  extra_scopes: ['decisions:commit'],
  workspaces: [{ id: 'ws_1', name: 'Acme', role: 'owner' }],
  expires_at: '2026-09-25T02:10:00.000Z',
}

const TWO_WORKSPACES = [
  { id: 'ws_1', name: 'Acme', role: 'owner' },
  { id: 'ws_2', name: 'Globex', role: 'member' },
]

const SESSION = { user_id: 'usr_1', session_id: 'ses_1', workspace_id: 'ws_1', role: 'owner', email_verified: true }

function LoginProbe(): React.JSX.Element {
  const location = useLocation()

  return <p>login at {`${location.pathname}${location.search}`}</p>
}

interface PageStubs {
  readonly signedOut?: boolean
  readonly onApprove?: (body: unknown) => void
  readonly workspaces?: readonly unknown[]
  /** The scopes the app asked for. Read and write objects unless a test says otherwise. */
  readonly scopes?: readonly string[]
  /** The extra permissions the server offers. `decisions:commit` unless a test says otherwise. */
  readonly extraScopes?: readonly string[]
  /** The workspace the session is in. `ws_1` unless a test says otherwise. */
  readonly activeWorkspaceId?: string
}

function renderPage(stubs: PageStubs = {}): void {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  const client = stubClient({
    get: (path) => {
      if (path === '/auth/me') {
        if (stubs.signedOut === true) {
          return Promise.reject(new ApiError(401, 'unauthorized', 'Sign in', []))
        }

        return { ...SESSION, workspace_id: stubs.activeWorkspaceId ?? SESSION.workspace_id }
      }

      if (path === '/oauth/requests/oar_1') {
        return {
          ...REQUEST,
          scopes: stubs.scopes ?? REQUEST.scopes,
          extra_scopes: stubs.extraScopes ?? REQUEST.extra_scopes,
          workspaces: stubs.workspaces ?? REQUEST.workspaces,
        }
      }

      throw new Error(`Unexpected get ${path}`)
    },
    post: (path, body) => {
      if (path === '/oauth/requests/oar_1/approve') {
        stubs.onApprove?.(body)

        return { redirect_url: 'https://client.example/callback?code=abc&state=xyz&iss=https%3A%2F%2Fkelpie.test' }
      }

      throw new Error(`Unexpected post ${path}`)
    },
  })

  render(
    <MemoryRouter initialEntries={['/consent/oar_1']}>
      <ApiProvider client={client} queryClient={queryClient}>
        <Routes>
          <Route path="/consent/:requestId" element={<ConsentPage />} />
          <Route path="/login" element={<LoginProbe />} />
        </Routes>
      </ApiProvider>
    </MemoryRouter>,
  )
}

describe('ConsentPage', () => {
  it('sends a signed-out person to sign in and back to this request', async () => {
    renderPage({ signedOut: true })

    expect(await screen.findByText('login at /login?next=%2Fconsent%2Foar_1')).toBeTruthy()
  })

  it('names the client and the host it sends the browser to', async () => {
    renderPage()

    expect(await screen.findByText('Connect Example Agent')).toBeTruthy()
    expect(screen.getByText('client.example')).toBeTruthy()
  })

  it('approves only the access left ticked, then leaves for the client', async () => {
    const assign = vi.fn()
    const approved: { body?: unknown } = {}

    vi.spyOn(window, 'location', 'get').mockReturnValue({ ...window.location, assign })
    renderPage({
      onApprove: (body) => {
        approved.body = body
      },
    })

    const write = await screen.findByRole('checkbox', { name: 'Write objects' })

    await act(async () => {
      write.click()
    })

    await act(async () => {
      screen.getByRole('button', { name: 'Allow' }).click()
    })

    await waitFor(() => {
      expect(approved.body).toEqual({ workspace_ids: ['ws_1'], scopes: ['read:objects'] })
    })
    expect(assign).toHaveBeenCalledWith(
      'https://client.example/callback?code=abc&state=xyz&iss=https%3A%2F%2Fkelpie.test',
    )
  })

  it('lists a per-resource scope only when no requested preset includes it', async () => {
    const approved: { body?: unknown } = {}

    vi.spyOn(window, 'location', 'get').mockReturnValue({ ...window.location, assign: vi.fn() })
    renderPage({
      scopes: ['read:objects', 'people:read', 'deals:read', 'webhooks:write'],
      onApprove: (body) => {
        approved.body = body
      },
    })

    expect(await screen.findByRole('checkbox', { name: 'Read objects' })).toBeTruthy()
    expect(screen.getByRole('checkbox', { name: 'Webhooks (write)' })).toBeTruthy()
    expect(screen.queryByRole('checkbox', { name: 'People (read)' })).toBeNull()
    expect(screen.queryByRole('checkbox', { name: 'Deals (read)' })).toBeNull()

    await act(async () => {
      screen.getByRole('button', { name: 'Allow' }).click()
    })

    await waitFor(() => {
      expect(approved.body).toEqual({ workspace_ids: ['ws_1'], scopes: ['read:objects', 'webhooks:write'] })
    })
  })

  it('drops what a preset included when the preset is cleared', async () => {
    const approved: { body?: unknown } = {}

    vi.spyOn(window, 'location', 'get').mockReturnValue({ ...window.location, assign: vi.fn() })
    renderPage({
      scopes: ['read:objects', 'write:objects', 'people:read'],
      onApprove: (body) => {
        approved.body = body
      },
    })

    const read = await screen.findByRole('checkbox', { name: 'Read objects' })

    await act(async () => {
      read.click()
    })

    await act(async () => {
      screen.getByRole('button', { name: 'Allow' }).click()
    })

    await waitFor(() => {
      expect(approved.body).toEqual({ workspace_ids: ['ws_1'], scopes: ['write:objects'] })
    })
  })

  it('offers an extra permission clear, with what it risks, and gives it only when ticked', async () => {
    const approved: unknown[] = []

    vi.spyOn(window, 'location', 'get').mockReturnValue({ ...window.location, assign: vi.fn() })
    renderPage({
      onApprove: (body) => {
        approved.push(body)
      },
    })

    const commit = (await screen.findByRole('checkbox', {
      name: /^Decisions \(commit without confirmation\)/u,
    })) as HTMLInputElement

    expect(commit.checked).toBe(false)
    expect(screen.getByRole('group', { name: 'Extra permissions' }).contains(commit)).toBe(true)
    expect(screen.getByText(/Lets it record a Decision as a commitment/u)).toBeTruthy()

    await act(async () => {
      commit.click()
    })
    await act(async () => {
      screen.getByRole('button', { name: 'Allow' }).click()
    })

    await waitFor(() => {
      expect(approved).toEqual([
        { workspace_ids: ['ws_1'], scopes: ['read:objects', 'write:objects', 'decisions:commit'] },
      ])
    })
  })

  it('gives no extra permission to a person who only clicks Allow, also when the app asked for it', async () => {
    const approved: { body?: unknown } = {}

    vi.spyOn(window, 'location', 'get').mockReturnValue({ ...window.location, assign: vi.fn() })
    renderPage({
      scopes: ['read:objects', 'write:objects', 'decisions:commit'],
      onApprove: (body) => {
        approved.body = body
      },
    })

    const boxes = await screen.findAllByRole('checkbox', { name: /^Decisions \(commit without confirmation\)/u })

    // Once, in its own section, and clear.
    expect(boxes).toHaveLength(1)
    expect((boxes[0] as HTMLInputElement).checked).toBe(false)

    await act(async () => {
      screen.getByRole('button', { name: 'Allow' }).click()
    })

    await waitFor(() => {
      expect(approved.body).toEqual({ workspace_ids: ['ws_1'], scopes: ['read:objects', 'write:objects'] })
    })
  })

  it('shows no extra section when the server offers none', async () => {
    renderPage({ extraScopes: [] })

    await screen.findByRole('checkbox', { name: 'Write objects' })

    expect(screen.queryByRole('group', { name: 'Extra permissions' })).toBeNull()
  })

  it('shows one workspace as text, with no choice to make', async () => {
    renderPage()

    expect(await screen.findByText('Acme')).toBeTruthy()
    expect(screen.queryByRole('checkbox', { name: /Acme/u })).toBeNull()
  })

  it('ticks only the workspace the session is in', async () => {
    renderPage({ workspaces: TWO_WORKSPACES, activeWorkspaceId: 'ws_2' })

    const globex = (await screen.findByRole('checkbox', { name: /Globex/u })) as HTMLInputElement
    const acme = screen.getByRole('checkbox', { name: /Acme/u }) as HTMLInputElement

    expect(globex.checked).toBe(true)
    expect(acme.checked).toBe(false)
  })

  it('approves each workspace left ticked, and says so before it does', async () => {
    const approved: { body?: unknown } = {}

    vi.spyOn(window, 'location', 'get').mockReturnValue({ ...window.location, assign: vi.fn() })
    renderPage({
      workspaces: TWO_WORKSPACES,
      onApprove: (body) => {
        approved.body = body
      },
    })

    const globex = await screen.findByRole('checkbox', { name: /Globex/u })

    expect(screen.queryByText('The app can read and write in each of these workspaces.')).toBeNull()

    await act(async () => {
      globex.click()
    })

    expect(screen.getByText('The app can read and write in each of these workspaces.')).toBeTruthy()

    await act(async () => {
      screen.getByRole('button', { name: 'Allow' }).click()
    })

    await waitFor(() => {
      expect(approved.body).toEqual({ workspace_ids: ['ws_1', 'ws_2'], scopes: ['read:objects', 'write:objects'] })
    })
  })

  it('does not allow a connection to no workspace', async () => {
    renderPage({ workspaces: TWO_WORKSPACES })

    const acme = await screen.findByRole('checkbox', { name: /Acme/u })

    await act(async () => {
      acme.click()
    })

    expect((screen.getByRole('button', { name: 'Allow' }) as HTMLButtonElement).disabled).toBe(true)
  })
})
