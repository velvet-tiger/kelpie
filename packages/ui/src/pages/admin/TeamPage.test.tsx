import { QueryClient } from '@tanstack/react-query'
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it } from 'vitest'

import { ApiProvider } from '../../api/ApiProvider.tsx'
import type { ApiClient } from '../../api/client.ts'
import { stubClient } from '../../testing/stubClient.ts'
import { TeamPage } from './TeamPage.tsx'

afterEach(cleanup)

/**
 * The invitation list on the team page. An invitation whose email did not
 * arrive looks like any other pending one unless the page says so: the person
 * who was invited has no link, and only an admin can do something about it.
 */

const REFUSAL = 'PermanentEmailError: 550 no mailbox grace@example.com'

function invite(email: string, failure: string | null = null): Record<string, unknown> {
  return {
    id: `inv_${email}`,
    email,
    role: 'member',
    status: 'pending',
    expires_at: '2026-08-12T00:00:00.000Z',
    email_failed_at: failure === null ? null : '2026-08-05T00:04:00.000Z',
    email_failure: failure,
    created_at: '2026-08-05T00:00:00.000Z',
  }
}

interface Stubs {
  readonly role?: string
  readonly invites: readonly Record<string, unknown>[]
  /** What a resend answers with. The list returns it from then on. */
  readonly onResend?: (path: string) => Record<string, unknown>
}

function teamClient(stubs: Stubs): ApiClient {
  let stored = stubs.invites

  return stubClient({
    get: (path) => {
      if (path !== '/auth/me') {
        throw new Error(`Unexpected get ${path}`)
      }

      return {
        user_id: 'usr_1',
        session_id: 'ses_1',
        workspace_id: 'ws_1',
        role: stubs.role ?? 'owner',
        email_verified: true,
      }
    },
    list: (path) => {
      if (path === '/workspaces/ws_1/invites') {
        return { items: stored, nextCursor: null }
      }

      if (path === '/workspaces/ws_1/members') {
        return { items: [], nextCursor: null }
      }

      throw new Error(`Unexpected list ${path}`)
    },
    post: (path) => {
      if (stubs.onResend === undefined || !path.endsWith('/resend')) {
        throw new Error(`Unexpected post ${path}`)
      }

      const resent = stubs.onResend(path)
      stored = stored.map((row) => (row.id === resent.id ? resent : row))

      return resent
    },
  })
}

function renderPage(stubs: Stubs): void {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })

  render(
    <MemoryRouter>
      <ApiProvider client={teamClient(stubs)} queryClient={queryClient}>
        <TeamPage />
      </ApiProvider>
    </MemoryRouter>,
  )
}

/** The table row that holds `email`. */
async function rowOf(email: string): Promise<HTMLElement> {
  const row = (await screen.findByText(email)).closest('tr')

  if (row === null) {
    throw new Error(`${email} is not in a table row`)
  }

  return row
}

describe('TeamPage invitations', () => {
  it('says the email was not delivered, with the reason, beside the Resend button', async () => {
    renderPage({ invites: [invite('grace@example.com', REFUSAL), invite('alan@example.com')] })

    const failed = within(await rowOf('grace@example.com'))

    expect(failed.getByText('Email not delivered')).toBeTruthy()
    expect(failed.getByText(REFUSAL)).toBeTruthy()
    expect(failed.getByRole('button', { name: 'Resend' })).toBeTruthy()
    // The invitation is still pending: the notice is beside the status, not in place of it.
    expect(failed.getByText(/^Pending until/u)).toBeTruthy()
  })

  it('shows no notice for an invitation whose email has no recorded failure', async () => {
    renderPage({ invites: [invite('grace@example.com', REFUSAL), invite('alan@example.com')] })

    const delivered = within(await rowOf('alan@example.com'))

    expect(delivered.queryByText('Email not delivered')).toBeNull()
    expect(delivered.getByText(/^Pending until/u)).toBeTruthy()
    expect(screen.getAllByText('Email not delivered')).toHaveLength(1)
  })

  it('says so when the mail server gave no reason', async () => {
    renderPage({ invites: [invite('grace@example.com', '')] })

    const failed = within(await rowOf('grace@example.com'))

    expect(failed.getByText('Email not delivered')).toBeTruthy()
    expect(failed.getByText('The mail server gave no reason.')).toBeTruthy()
  })

  it('removes the notice after a resend, which the API answers with no failure', async () => {
    const resent: string[] = []

    renderPage({
      invites: [invite('grace@example.com', REFUSAL)],
      onResend: (path) => {
        resent.push(path)

        return invite('grace@example.com')
      },
    })

    const row = await rowOf('grace@example.com')

    expect(within(row).getByText('Email not delivered')).toBeTruthy()

    act(() => {
      within(row).getByRole('button', { name: 'Resend' }).click()
    })

    await waitFor(() => {
      expect(screen.queryByText('Email not delivered')).toBeNull()
    })
    expect(resent).toEqual(['/workspaces/ws_1/invites/inv_grace@example.com/resend'])
    expect(screen.getByText('grace@example.com')).toBeTruthy()
  })

  it('shows a member no invitations at all', async () => {
    renderPage({ role: 'member', invites: [invite('grace@example.com', REFUSAL)] })

    expect(await screen.findByText('Active members')).toBeTruthy()
    expect(screen.queryByText('Email not delivered')).toBeNull()
    expect(screen.queryByText('Invitations')).toBeNull()
  })
})
