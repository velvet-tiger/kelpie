import { QueryClient } from '@tanstack/react-query'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, describe, expect, it } from 'vitest'

import { ApiProvider } from '../../api/ApiProvider.tsx'
import { ApiError } from '../../api/client.ts'
import type { ApiClient } from '../../api/client.ts'
import { ForgotPasswordPage } from './ForgotPasswordPage.tsx'
import { ResetPasswordPage } from './ResetPasswordPage.tsx'
import { SignUpPage } from './SignUpPage.tsx'

afterEach(cleanup)

/**
 * What these pages can get wrong in a way a reader would believe.
 *
 * Two of them are about telling the truth rather than about wiring. A reset
 * request that says "no such account" is an account-existence oracle, and a
 * password rule the browser does not state is one the reader meets as a
 * rejection. The rest is that each page spends its one request correctly.
 */

const SESSION = { user_id: 'usr_1', session_id: 'ses_1', workspace_id: null, role: null }

interface Calls {
  posted: { path: string; body: unknown }[]
}

interface Stubs {
  /** Thrown by the next write, to stand in for the service refusing it. */
  readonly writeFails?: ApiError
}

function stubClient(calls: Calls, stubs: Stubs = {}): ApiClient {
  const unexpected = (what: string): never => {
    throw new Error(`Unexpected ${what}`)
  }

  return {
    get: (path, decode) =>
      path === '/auth/me' ? Promise.resolve(decode(SESSION)) : unexpected(`get ${path}`),
    post: (path, body, decode) => {
      calls.posted.push({ path, body })

      if (stubs.writeFails !== undefined) {
        return Promise.reject(stubs.writeFails)
      }

      return Promise.resolve(
        decode({ account: { id: 'usr_1', email: 'ada@example.com', name: 'Ada' }, active_workspace_id: null }),
      )
    },
    postEmpty: (path, body) => {
      calls.posted.push({ path, body })

      return stubs.writeFails === undefined ? Promise.resolve() : Promise.reject(stubs.writeFails)
    },
    list: () => unexpected('list'),
    patch: () => unexpected('patch'),
    patchEmpty: () => unexpected('patchEmpty'),
    delete: () => unexpected('delete'),
    getText: () => unexpected('getText'),
    postForm: () => unexpected('postForm'),
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

/**
 * A field's accessible name is its label plus the hint under it, so the match
 * is on the opening words rather than the whole string.
 */
async function type(label: string, value: string): Promise<void> {
  const field = screen.getByLabelText(new RegExp(`^${label}`, 'u'))

  await act(async () => {
    setInputValue(field, value)
  })
}

async function press(name: RegExp | string): Promise<void> {
  await act(async () => {
    screen.getByRole('button', { name }).click()
  })
}

function renderAt(
  path: string,
  element: React.JSX.Element,
  calls: Calls,
  stubs: Stubs = {},
): void {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })

  render(
    <MemoryRouter initialEntries={[path]}>
      <ApiProvider client={stubClient(calls, stubs)} queryClient={queryClient}>
        <Routes>
          <Route path={path.split('?')[0]} element={element} />
          {/* Standing in for the pages this one hands off to, so a redirect is
              something the test can see rather than infer. */}
          <Route path="/onboarding/workspace" element={<p>onboarding step 1</p>} />
        </Routes>
      </ApiProvider>
    </MemoryRouter>,
  )
}

function noCalls(): Calls {
  return { posted: [] }
}

describe('SignUpPage', () => {
  it('creates the account and hands off to onboarding', async () => {
    const calls = noCalls()

    renderAt('/signup', <SignUpPage />, calls)

    await type('Your name', 'Ada Lovelace')
    await type('Email', 'ada@example.com')
    await type('Password', 'a long enough password')
    await press('Continue')

    await waitFor(() => {
      expect(calls.posted).toEqual([
        {
          path: '/auth/signup',
          body: {
            name: 'Ada Lovelace',
            email: 'ada@example.com',
            password: 'a long enough password',
          },
        },
      ])
    })

    expect(await screen.findByText('onboarding step 1')).toBeTruthy()
  })

  /**
   * The service refuses this too. Stating it in the browser is what turns a
   * `422` into a rule the reader knew before pressing the button.
   */
  it('states the password rule instead of spending a request on it', async () => {
    const calls = noCalls()

    renderAt('/signup', <SignUpPage />, calls)

    await type('Your name', 'Ada Lovelace')
    await type('Email', 'ada@example.com')
    await type('Password', 'short')
    await press('Continue')

    expect(screen.getByText('Password must be at least 12 characters.')).toBeTruthy()
    expect(calls.posted).toEqual([])
  })

  it('shows what the service refused', async () => {
    const calls = noCalls()

    renderAt('/signup', <SignUpPage />, calls, {
      writeFails: new ApiError(409, 'conflict', 'That email address is already registered'),
    })

    await type('Your name', 'Ada Lovelace')
    await type('Email', 'taken@example.com')
    await type('Password', 'a long enough password')
    await press('Continue')

    expect(await screen.findByText('That email address is already registered')).toBeTruthy()
    expect(screen.queryByText('onboarding step 1')).toBeNull()
  })
})

describe('ForgotPasswordPage', () => {
  /**
   * The endpoint answers `202` either way on purpose. A page that said "no
   * account with that address" would hand back the one thing the `202` exists
   * to withhold.
   */
  it('never says whether the address is registered', async () => {
    const calls = noCalls()

    renderAt('/forgot-password', <ForgotPasswordPage />, calls)

    await type('Email', 'stranger@example.com')
    await press('Send reset link')

    expect(await screen.findByText(/If an account exists for/u)).toBeTruthy()
    expect(screen.getByText('stranger@example.com')).toBeTruthy()
  })

  /** The service sends the mail and has no idea where this browser reached it. */
  it('supplies the URL the emailed token goes into', async () => {
    const calls = noCalls()

    renderAt('/forgot-password', <ForgotPasswordPage />, calls)

    await type('Email', 'ada@example.com')
    await press('Send reset link')

    await waitFor(() => {
      expect(calls.posted).toHaveLength(1)
    })

    const body = calls.posted[0]?.body as Record<string, string>

    expect(calls.posted[0]?.path).toBe('/auth/password-reset')
    expect(body.email).toBe('ada@example.com')
    expect(body.reset_url_template).toContain('/reset-password?token={token}')
  })
})

describe('ResetPasswordPage', () => {
  it('sets the new password with the token from the link', async () => {
    const calls = noCalls()

    renderAt('/reset-password?token=tok_abc', <ResetPasswordPage />, calls)

    await type('New password', 'a long enough password')
    await type('Confirm new password', 'a long enough password')
    await press('Set new password')

    await waitFor(() => {
      expect(calls.posted).toEqual([
        {
          path: '/auth/password-reset/confirm',
          body: { token: 'tok_abc', password: 'a long enough password' },
        },
      ])
    })

    // The service ended every session, this browser's included, so the page must
    // not imply the reader is now signed in.
    expect(await screen.findByText(/signed out/u)).toBeTruthy()
  })

  it('refuses a confirmation that does not match, without spending the token', async () => {
    const calls = noCalls()

    renderAt('/reset-password?token=tok_abc', <ResetPasswordPage />, calls)

    await type('New password', 'a long enough password')
    await type('Confirm new password', 'a different long password')
    await press('Set new password')

    expect(screen.getByText(/do not match/u)).toBeTruthy()
    expect(calls.posted).toEqual([])
  })

  it('says the link is incomplete rather than posting an empty token', async () => {
    const calls = noCalls()

    renderAt('/reset-password', <ResetPasswordPage />, calls)

    expect(screen.getByText('This link is incomplete')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Set new password' })).toBeNull()
    expect(calls.posted).toEqual([])
  })
})
