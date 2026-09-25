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
 * approving more than the person left ticked.
 */

const REQUEST = {
  id: 'oar_1',
  client_name: 'Example Agent',
  client_host: 'client.example',
  client_uri: null,
  logo_uri: null,
  scopes: ['read:objects', 'write:objects'],
  workspaces: [{ id: 'ws_1', name: 'Acme', role: 'owner' }],
  expires_at: '2026-09-25T02:10:00.000Z',
}

const SESSION = { user_id: 'usr_1', session_id: 'ses_1', workspace_id: 'ws_1', role: 'owner', email_verified: true }

function LoginProbe(): React.JSX.Element {
  const location = useLocation()

  return <p>login at {`${location.pathname}${location.search}`}</p>
}

function renderPage(stubs: { signedOut?: boolean; onApprove?: (body: unknown) => void } = {}): void {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  const client = stubClient({
    get: (path) => {
      if (path === '/auth/me') {
        if (stubs.signedOut === true) {
          return Promise.reject(new ApiError(401, 'unauthorized', 'Sign in', []))
        }

        return SESSION
      }

      if (path === '/oauth/requests/oar_1') {
        return REQUEST
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
      expect(approved.body).toEqual({ workspace_id: 'ws_1', scopes: ['read:objects'] })
    })
    expect(assign).toHaveBeenCalledWith(
      'https://client.example/callback?code=abc&state=xyz&iss=https%3A%2F%2Fkelpie.test',
    )
  })
})
