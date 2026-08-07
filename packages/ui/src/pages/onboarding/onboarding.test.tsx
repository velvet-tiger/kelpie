import { QueryClient } from '@tanstack/react-query'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, describe, expect, it } from 'vitest'

import { ApiProvider } from '../../api/ApiProvider.tsx'
import { ApiError } from '../../api/client.ts'
import type { ApiClient } from '../../api/client.ts'
import { stubClient } from '../../testing/stubClient.ts'
import { HandbookStepPage } from './HandbookStepPage.tsx'
import { InvitesStepPage } from './InvitesStepPage.tsx'
import { WorkspaceStepPage } from './WorkspaceStepPage.tsx'

afterEach(cleanup)

/**
 * Onboarding against the real API, where each step commits as it is finished
 * rather than collecting a draft and writing the lot at the end.
 *
 * That is what these cover: the workspace request carries what was typed, an
 * invitation that fails does not take its neighbours down or get sent twice,
 * and the handbook step reports the pages that exist rather than claiming to
 * make them.
 */

const WORKSPACE = {
  id: 'wsp_1',
  name: 'Acme Labs',
  slug: 'acme-labs',
  timezone: 'Australia/Sydney',
  tagline: null,
  one_liner: null,
}

function invite(email: string, role: string): Record<string, unknown> {
  return {
    id: `inv_${email}`,
    email,
    role,
    status: 'pending',
    expires_at: '2026-08-12T00:00:00.000Z',
    created_at: '2026-08-05T00:00:00.000Z',
  }
}

function handbookPage(id: string, title: string): Record<string, unknown> {
  return {
    id,
    title,
    slug: title.toLowerCase().replace(/ /gu, '-'),
    parent_id: null,
    body: '',
    sort_order: 0,
    updated_by: null,
    created_at: '2026-08-05T00:00:00.000Z',
    updated_at: '2026-08-05T00:00:00.000Z',
  }
}

interface Calls {
  posted: { path: string; body: unknown }[]
}

interface Stubs {
  readonly workspaceId?: string | null
  readonly pages?: readonly Record<string, unknown>[]
  /** Addresses the service refuses, so a row can fail while its neighbours do not. */
  readonly rejectEmails?: readonly string[]
  /** `GET /auth/me` answers `401`: nobody is signed in. */
  readonly signedOut?: boolean
}

function onboardingClient(calls: Calls, stubs: Stubs = {}): ApiClient {
  const session = {
    user_id: 'usr_1',
    session_id: 'ses_1',
    workspace_id: stubs.workspaceId === undefined ? 'wsp_1' : stubs.workspaceId,
    role: 'owner',
  }

  return stubClient({
    get: (path) => {
      if (path !== '/auth/me') {
        throw new Error(`Unexpected get ${path}`)
      }

      return stubs.signedOut === true
        ? Promise.reject(new ApiError(401, 'unauthorized', 'Sign in to continue'))
        : session
    },
    list: (path) => {
      if (path !== '/handbook_pages') {
        throw new Error(`Unexpected list ${path}`)
      }

      return { items: stubs.pages ?? [], nextCursor: null }
    },
    post: (path, body) => {
      calls.posted.push({ path, body })

      if (path === '/workspaces') {
        return WORKSPACE
      }

      const sent = body as { email: string; role: string }

      if (stubs.rejectEmails?.includes(sent.email) === true) {
        return Promise.reject(new ApiError(409, 'conflict', 'That person is already a member'))
      }

      return invite(sent.email, sent.role)
    },
  })
}

/** React tracks the value on the node, so a plain assignment is not seen. */
function setValue(element: HTMLElement, value: string): void {
  const prototype =
    element instanceof globalThis.HTMLSelectElement
      ? globalThis.HTMLSelectElement.prototype
      : globalThis.HTMLInputElement.prototype

  Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(element, value)
  element.dispatchEvent(new Event(element instanceof globalThis.HTMLSelectElement ? 'change' : 'input', { bubbles: true }))
}

async function press(name: RegExp | string): Promise<void> {
  await act(async () => {
    screen.getByRole('button', { name }).click()
  })
}

function renderStep(element: React.JSX.Element, calls: Calls, stubs: Stubs = {}): void {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })

  render(
    <MemoryRouter initialEntries={['/step']}>
      <ApiProvider client={onboardingClient(calls, stubs)} queryClient={queryClient}>
        <Routes>
          <Route path="/step" element={element} />
          {/* Standing in for what each step hands off to, so moving on is
              something the test can see. */}
          <Route path="/onboarding/invites" element={<p>step 2</p>} />
          <Route path="/onboarding/handbook" element={<p>step 3</p>} />
          <Route path="/dashboard" element={<p>the app</p>} />
          <Route path="/login" element={<p>sign in</p>} />
        </Routes>
      </ApiProvider>
    </MemoryRouter>,
  )
}

function noCalls(): Calls {
  return { posted: [] }
}

describe('WorkspaceStepPage', () => {
  it('derives the slug from the name and creates the workspace', async () => {
    const calls = noCalls()

    renderStep(<WorkspaceStepPage />, calls, { workspaceId: null })

    await act(async () => {
      setValue(screen.getByLabelText(/^Workspace name/u), 'Acme Labs')
    })

    expect((screen.getByLabelText(/^Slug/u) as HTMLInputElement).value).toBe('acme-labs')

    await press('Continue')

    await waitFor(() => {
      expect(calls.posted).toHaveLength(1)
    })

    const body = calls.posted[0]?.body as Record<string, string>

    expect(calls.posted[0]?.path).toBe('/workspaces')
    expect(body.name).toBe('Acme Labs')
    expect(body.slug).toBe('acme-labs')
    // Whatever the platform reports. Asserting a specific zone would assert the
    // machine the test runs on.
    expect(body.timezone).toBeTruthy()

    expect(await screen.findByText('step 2')).toBeTruthy()
  })

  /**
   * The page is outside `SessionGate`, because being sent here is what the gate
   * does with an account that has no workspace. Without its own check, a signed
   * out visitor would fill in a form whose only possible answer is `401`.
   */
  it('sends a signed-out visitor to sign in rather than showing the form', async () => {
    const calls = noCalls()

    renderStep(<WorkspaceStepPage />, calls, { signedOut: true })

    expect(await screen.findByText('sign in')).toBeTruthy()
    expect(screen.queryByText('Create your workspace')).toBeNull()
  })

  it('keeps an edited slug within what the API accepts', async () => {
    const calls = noCalls()

    renderStep(<WorkspaceStepPage />, calls, { workspaceId: null })

    await act(async () => {
      setValue(screen.getByLabelText(/^Slug/u), 'Acme Labs!!')
    })

    expect((screen.getByLabelText(/^Slug/u) as HTMLInputElement).value).toBe('acme-labs')
  })
})

describe('InvitesStepPage', () => {
  it('sends one invitation per filled row, then moves on', async () => {
    const calls = noCalls()

    renderStep(<InvitesStepPage />, calls)

    await act(async () => {
      setValue(screen.getAllByPlaceholderText('colleague@company.com')[0] as HTMLElement, 'grace@example.com')
    })

    await press('Add another')

    const rows = screen.getAllByPlaceholderText('colleague@company.com')

    await act(async () => {
      setValue(rows[1] as HTMLElement, 'alan@example.com')
    })

    await act(async () => {
      setValue(screen.getAllByRole('combobox')[1] as HTMLElement, 'admin')
    })

    await press('Send invitations')

    await waitFor(() => {
      expect(calls.posted).toHaveLength(2)
    })

    expect(calls.posted.map((call) => call.path)).toEqual([
      '/workspaces/wsp_1/invites',
      '/workspaces/wsp_1/invites',
    ])

    const bodies = calls.posted.map((call) => call.body as Record<string, string>)

    expect(bodies[0]?.email).toBe('grace@example.com')
    expect(bodies[0]?.role).toBe('member')
    expect(bodies[1]?.email).toBe('alan@example.com')
    expect(bodies[1]?.role).toBe('admin')
    // The service sends the mail and does not know where this browser is.
    expect(bodies[0]?.invite_url_template).toContain('/join?token={token}')

    expect(await screen.findByText('step 3')).toBeTruthy()
  })

  /**
   * The case the mockup could not have: one address is refused and the others
   * are not. Retrying must not send the accepted ones a second time, and the
   * step must not advance while one is still outstanding.
   */
  it('reports the refused row and does not resend the accepted one', async () => {
    const calls = noCalls()

    renderStep(<InvitesStepPage />, calls, { rejectEmails: ['taken@example.com'] })

    await act(async () => {
      setValue(screen.getAllByPlaceholderText('colleague@company.com')[0] as HTMLElement, 'grace@example.com')
    })

    await press('Add another')

    await act(async () => {
      setValue(
        screen.getAllByPlaceholderText('colleague@company.com')[1] as HTMLElement,
        'taken@example.com',
      )
    })

    await press('Send invitations')

    expect(await screen.findByText('That person is already a member')).toBeTruthy()
    expect(screen.getByText('Invitation sent')).toBeTruthy()
    expect(screen.queryByText('step 3')).toBeNull()

    await press('Send invitations')

    await waitFor(() => {
      expect(calls.posted).toHaveLength(3)
    })

    // Three requests, not four: the accepted address was sent once.
    expect(calls.posted.filter((call) => (call.body as { email: string }).email === 'grace@example.com')).toHaveLength(1)
  })

  it('skips without sending anything', async () => {
    const calls = noCalls()

    renderStep(<InvitesStepPage />, calls)

    await press('Skip for now')

    expect(await screen.findByText('step 3')).toBeTruthy()
    expect(calls.posted).toEqual([])
  })
})

describe('HandbookStepPage', () => {
  /**
   * The pages already exist: `POST /v1/workspaces` seeded them two steps ago.
   * This step reads them back, so a title that is not really there cannot
   * appear on it.
   */
  it('lists the pages the workspace was seeded with', async () => {
    const calls = noCalls()

    renderStep(<HandbookStepPage />, calls, {
      pages: [handbookPage('hbp_1', 'About us'), handbookPage('hbp_2', 'Ideal customer profile')],
    })

    expect(await screen.findByText('About us')).toBeTruthy()
    expect(screen.getByText('Ideal customer profile')).toBeTruthy()
    expect(calls.posted).toEqual([])

    await press('Go to Kelpie')

    expect(await screen.findByText('the app')).toBeTruthy()
  })

  /** An empty list means the seeding did not happen, which is worth saying. */
  it('says so when there are no pages, rather than drawing an empty box', async () => {
    const calls = noCalls()

    renderStep(<HandbookStepPage />, calls, { pages: [] })

    expect(await screen.findByText(/no handbook pages/u)).toBeTruthy()
    expect(screen.queryByText(/Every page starts as a stub/u)).toBeNull()
  })
})
