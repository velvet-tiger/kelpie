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
  local_client: false,
  workspaces: [{ id: 'ws_1', name: 'Acme', role: 'owner', connected: false, held_scopes: [] }],
  expires_at: '2026-09-25T02:10:00.000Z',
}

const TWO_WORKSPACES = [
  { id: 'ws_1', name: 'Acme', role: 'owner', connected: false, held_scopes: [] },
  { id: 'ws_2', name: 'Globex', role: 'member', connected: false, held_scopes: [] },
]

const ALL_EXTRAS = ['decisions:commit', 'handbook:write', 'delete:objects']

const SESSION = { user_id: 'usr_1', session_id: 'ses_1', workspace_id: 'ws_1', role: 'owner', email_verified: true }

function LoginProbe(): React.JSX.Element {
  const location = useLocation()

  return <p>login at {`${location.pathname}${location.search}`}</p>
}

interface PageStubs {
  readonly signedOut?: boolean
  readonly onApprove?: (body: unknown) => void
  readonly workspaces?: readonly Record<string, unknown>[]
  /** The scopes the app asked for. Read and write objects unless a test says otherwise. */
  readonly scopes?: readonly string[]
  /** The extra permissions the server offers. `decisions:commit` unless a test says otherwise. */
  readonly extraScopes?: readonly string[]
  /** True for an app that redirects to this computer. False unless a test says otherwise. */
  readonly localClient?: boolean
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
          local_client: stubs.localClient ?? REQUEST.local_client,
          // The display fields say nothing unless a test gives them.
          workspaces: (stubs.workspaces ?? REQUEST.workspaces).map((workspace) => ({
            display_connected: false,
            display_held_scopes: [],
            ...workspace,
          })),
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

  it('says what each extra permission risks, and gives the ones the person ticks', async () => {
    const approved: { body?: unknown } = {}

    vi.spyOn(window, 'location', 'get').mockReturnValue({ ...window.location, assign: vi.fn() })
    renderPage({
      extraScopes: ['decisions:commit', 'handbook:write', 'delete:objects'],
      onApprove: (body) => {
        approved.body = body
      },
    })

    const remove = (await screen.findByRole('checkbox', { name: /^Delete objects/u })) as HTMLInputElement
    const handbook = screen.getByRole('checkbox', { name: /^Handbook \(write\)/u }) as HTMLInputElement

    expect(remove.checked).toBe(false)
    expect(handbook.checked).toBe(false)
    expect(screen.getByText('Lets it delete records and handbook pages. A deleted record cannot be restored.')).toBeTruthy()
    expect(screen.getByText(/Lets it create and change handbook pages/u)).toBeTruthy()

    await act(async () => {
      remove.click()
    })
    await act(async () => {
      screen.getByRole('button', { name: 'Allow' }).click()
    })

    await waitFor(() => {
      expect(approved.body).toEqual({
        workspace_ids: ['ws_1'],
        scopes: ['read:objects', 'write:objects', 'delete:objects'],
      })
    })
  })

  /** Renders the page, clicks what the test names, clicks Allow, and answers the approved body. */
  async function approveAfter(stubs: PageStubs, clicks: readonly RegExp[]): Promise<unknown> {
    const approved: { body?: unknown } = {}

    vi.spyOn(window, 'location', 'get').mockReturnValue({ ...window.location, assign: vi.fn() })
    renderPage({
      ...stubs,
      onApprove: (body) => {
        approved.body = body
      },
    })

    await screen.findByText('Connect Example Agent')

    for (const name of clicks) {
      await act(async () => {
        screen.getByRole('checkbox', { name }).click()
      })
    }

    await act(async () => {
      screen.getByRole('button', { name: 'Allow' }).click()
    })
    await waitFor(() => {
      expect(approved.body).toBeDefined()
    })

    return approved.body
  }

  function box(name: RegExp): HTMLInputElement {
    return screen.getByRole('checkbox', { name }) as HTMLInputElement
  }

  /**
   * The request the server's own `insufficient_scope` answer leads to when a
   * token holds nothing else: every scope in it is an extra.
   */
  it('allows a request whose scopes are all extras once one is ticked, and not before', async () => {
    const stubs = { scopes: ['handbook:write'], extraScopes: ALL_EXTRAS.toSorted() }

    renderPage(stubs)

    const allow = (await screen.findByRole('button', { name: 'Allow' })) as HTMLButtonElement

    expect(allow.disabled).toBe(true)
    expect(box(/^Handbook \(write\)/u).checked).toBe(false)
    expect(screen.getByText(/this app asks for it/u)).toBeTruthy()

    await act(async () => {
      box(/^Handbook \(write\)/u).click()
    })

    expect(allow.disabled).toBe(false)

    cleanup()

    expect(await approveAfter(stubs, [/^Handbook \(write\)/u])).toEqual({
      workspace_ids: ['ws_1'],
      scopes: ['handbook:write'],
    })
  })

  it('allows an approval of one extra with every requested scope cleared', async () => {
    const body = await approveAfter({}, [/^Read objects/u, /^Write objects/u, /^Decisions \(commit/u])

    expect(body).toEqual({ workspace_ids: ['ws_1'], scopes: ['decisions:commit'] })
  })

  it('does not allow an approval with nothing ticked at all', async () => {
    renderPage()

    for (const name of [/^Read objects/u, /^Write objects/u]) {
      await act(async () => {
        ;(await screen.findByRole('checkbox', { name })).click()
      })
    }

    expect((screen.getByRole('button', { name: 'Allow' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('shows a requested delete scope of one resource apart and clear, with what it risks', async () => {
    const stubs = {
      scopes: ['read:objects', 'write:objects', 'people:delete'],
      extraScopes: ['people:delete', ...ALL_EXTRAS],
    }

    renderPage(stubs)
    await screen.findByText('Connect Example Agent')

    expect(box(/^People \(delete\)/u).checked).toBe(false)
    expect(screen.getByRole('group', { name: 'Extra permissions' }).contains(box(/^People \(delete\)/u))).toBe(true)
    expect(screen.getByText('Lets it delete records of this kind: People. A deleted record cannot be restored.')).toBeTruthy()
    // Delete objects is still offered beside it.
    expect(box(/^Delete objects/u).checked).toBe(false)

    cleanup()

    expect(await approveAfter(stubs, [])).toEqual({ workspace_ids: ['ws_1'], scopes: ['read:objects', 'write:objects'] })
  })

  it('shows a requested preset that holds a sensitive scope apart and clear, whole', async () => {
    const stubs = { scopes: ['read:all', 'write:all'], extraScopes: ['write:all', ...ALL_EXTRAS] }

    renderPage(stubs)
    await screen.findByText('Connect Example Agent')

    expect(box(/^Write all/u).checked).toBe(false)
    expect(box(/^Read all/u).checked).toBe(true)
    // It says that the preset is also the ordinary record write.
    expect(
      screen.getByText('Lets it change every record, the handbook and workspace settings: members, API keys and webhooks.'),
    ).toBeTruthy()

    cleanup()

    expect(await approveAfter(stubs, [])).toEqual({ workspace_ids: ['ws_1'], scopes: ['read:all'] })

    cleanup()

    expect(await approveAfter(stubs, [/^Write all/u])).toEqual({
      workspace_ids: ['ws_1'],
      scopes: ['read:all', 'write:all'],
    })
  })

  it('starts an extra ticked only when the app has it already, and says so', async () => {
    const stubs = {
      extraScopes: ALL_EXTRAS,
      workspaces: [
        { id: 'ws_1', name: 'Acme', role: 'owner', connected: true, held_scopes: ['handbook:write', 'delete:objects'] },
      ],
    }

    renderPage(stubs)
    await screen.findByText('Connect Example Agent')

    expect(box(/^Handbook \(write\)/u).checked).toBe(true)
    expect(box(/^Delete objects/u).checked).toBe(true)
    expect(box(/^Decisions \(commit/u).checked).toBe(false)
    expect(screen.getAllByText(/· already allowed/u)).toHaveLength(2)

    cleanup()

    expect(await approveAfter(stubs, [])).toEqual({
      workspace_ids: ['ws_1'],
      scopes: ['read:objects', 'write:objects', 'handbook:write', 'delete:objects'],
    })

    cleanup()

    // Clearing one that is already allowed takes it away.
    expect(await approveAfter(stubs, [/^Delete objects/u])).toEqual({
      workspace_ids: ['ws_1'],
      scopes: ['read:objects', 'write:objects', 'handbook:write'],
    })
  })

  it('clears an extra again when a selected workspace does not have it yet', async () => {
    const stubs = {
      extraScopes: ALL_EXTRAS,
      workspaces: [
        { id: 'ws_1', name: 'Acme', role: 'owner', connected: true, held_scopes: ['delete:objects'] },
        { id: 'ws_2', name: 'Globex', role: 'member', connected: false, held_scopes: [] },
      ],
    }

    renderPage(stubs)

    expect((await screen.findByRole('checkbox', { name: /^Delete objects/u }) as HTMLInputElement).checked).toBe(true)

    await act(async () => {
      box(/Globex/u).click()
    })

    // Globex would get a delete that nobody ticked.
    expect(box(/^Delete objects/u).checked).toBe(false)
    expect(screen.queryByText(/· already allowed/u)).toBeNull()

    cleanup()

    expect(await approveAfter(stubs, [/Globex/u])).toEqual({
      workspace_ids: ['ws_1', 'ws_2'],
      scopes: ['read:objects', 'write:objects'],
    })

    cleanup()

    // A tick the person made stays when the workspaces change.
    expect(await approveAfter(stubs, [/^Decisions \(commit/u, /Globex/u])).toEqual({
      workspace_ids: ['ws_1', 'ws_2'],
      scopes: ['read:objects', 'write:objects', 'decisions:commit'],
    })
  })

  /**
   * The app is connected to Globex and asks for more. The person's session is
   * in Acme. An approval for Acme would make a new connection there and end
   * the one that asked.
   */
  it('opens on the workspaces the app is connected to, not on the one the session is in', async () => {
    const stubs = {
      activeWorkspaceId: 'ws_1',
      extraScopes: ALL_EXTRAS,
      workspaces: [
        { id: 'ws_1', name: 'Acme', role: 'owner', connected: false, held_scopes: [] },
        { id: 'ws_2', name: 'Globex', role: 'member', connected: true, held_scopes: ['delete:objects'] },
        { id: 'ws_3', name: 'Initech', role: 'member', connected: true, held_scopes: ['delete:objects'] },
      ],
    }

    renderPage(stubs)
    await screen.findByText('Connect Example Agent')

    expect(box(/Acme/u).checked).toBe(false)
    expect(box(/Globex/u).checked).toBe(true)
    expect(box(/Initech/u).checked).toBe(true)
    // So what the connection holds is found, and kept by a person who only clicks Allow.
    expect(box(/^Delete objects/u).checked).toBe(true)

    cleanup()

    expect(await approveAfter(stubs, [])).toEqual({
      workspace_ids: ['ws_2', 'ws_3'],
      scopes: ['read:objects', 'write:objects', 'delete:objects'],
    })
  })

  it('opens on the workspace of the session for an app that is not connected yet', async () => {
    renderPage({ workspaces: TWO_WORKSPACES, activeWorkspaceId: 'ws_2' })

    expect((await screen.findByRole('checkbox', { name: /Globex/u }) as HTMLInputElement).checked).toBe(true)
    expect(box(/Acme/u).checked).toBe(false)
  })

  it('shows a narrower extra as ticked and locked while a wider ticked one gives it, and sends only what was ticked', async () => {
    const stubs = {
      scopes: ['read:all', 'write:all', 'people:delete'],
      extraScopes: ['write:all', 'people:delete', ...ALL_EXTRAS],
    }

    renderPage(stubs)
    await screen.findByText('Connect Example Agent')

    expect(box(/^People \(delete\)/u).checked).toBe(false)
    expect(box(/^People \(delete\)/u).disabled).toBe(false)

    await act(async () => {
      box(/^Delete objects/u).click()
    })
    await act(async () => {
      box(/^Write all/u).click()
    })

    // The two rows cannot say that the app does not get what the wider rows give it.
    expect(box(/^People \(delete\)/u).checked).toBe(true)
    expect(box(/^People \(delete\)/u).disabled).toBe(true)
    expect(box(/^Handbook \(write\)/u).checked).toBe(true)
    expect(box(/^Handbook \(write\)/u).disabled).toBe(true)
    expect(screen.getByText('· included in Delete objects')).toBeTruthy()
    expect(screen.getByText('· included in Write all')).toBeTruthy()
    // A scope that no ticked row gives stays the person's to choose.
    expect(box(/^Decisions \(commit/u).checked).toBe(false)
    expect(box(/^Decisions \(commit/u).disabled).toBe(false)

    await act(async () => {
      box(/^Delete objects/u).click()
    })

    // Clearing the wider row gives the narrower one back, clear as it was.
    expect(box(/^People \(delete\)/u).checked).toBe(false)
    expect(box(/^People \(delete\)/u).disabled).toBe(false)

    cleanup()

    expect(await approveAfter(stubs, [/^Delete objects/u, /^Write all/u])).toEqual({
      workspace_ids: ['ws_1'],
      scopes: ['read:all', 'write:all', 'delete:objects'],
    })

    cleanup()

    // A narrower row the person ticked first is sent with the wider one: the union, no more.
    expect(await approveAfter(stubs, [/^People \(delete\)/u, /^Delete objects/u])).toEqual({
      workspace_ids: ['ws_1'],
      scopes: ['read:all', 'people:delete', 'delete:objects'],
    })
  })

  /**
   * What the server sends for an app on the person's computer: nothing
   * connected and nothing held, whatever the app was allowed before.
   */
  it('ticks nothing for an app that runs on this computer, and says why', async () => {
    const stubs = {
      localClient: true,
      activeWorkspaceId: 'ws_2',
      extraScopes: ALL_EXTRAS,
      workspaces: TWO_WORKSPACES,
    }

    renderPage(stubs)
    await screen.findByText('Connect Example Agent')

    const explanation = screen.getByText(
      /This app runs on your computer, so Kelpie does not use what you allowed it before/u,
    )

    // The app replaces its tokens, so it must not read as if the other workspaces keep working.
    expect(explanation.textContent).toContain(
      'What it has now is marked. After you select Allow, the app uses only the workspaces that you tick here. Tick a connected workspace again to keep it.',
    )
    expect(explanation.textContent).not.toContain('stays in place')
    // Above the workspaces, which are the first thing it explains.
    expect(
      explanation.compareDocumentPosition(screen.getByRole('group', { name: 'Workspaces' })) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).not.toBe(0)
    // The workspace of the session, as for an app that is new.
    expect(box(/Globex/u).checked).toBe(true)
    expect(box(/Acme/u).checked).toBe(false)

    for (const name of [/^Decisions \(commit/u, /^Handbook \(write\)/u, /^Delete objects/u]) {
      expect(box(name).checked).toBe(false)
    }

    expect(screen.queryByText(/· already allowed/u)).toBeNull()

    cleanup()

    expect(await approveAfter(stubs, [])).toEqual({ workspace_ids: ['ws_2'], scopes: ['read:objects', 'write:objects'] })
  })

  /**
   * A desktop agent connected to Globex and Initech, with delete, asks for
   * more while the person's session is in Acme. The page must say what the
   * agent has, and must not tick any of it.
   */
  it('shows what an app on this computer has now, and ticks nothing from it', async () => {
    const stubs = {
      localClient: true,
      activeWorkspaceId: 'ws_1',
      extraScopes: ALL_EXTRAS,
      workspaces: [
        { id: 'ws_1', name: 'Acme', role: 'owner', connected: false, held_scopes: [] },
        {
          id: 'ws_2',
          name: 'Globex',
          role: 'member',
          connected: false,
          held_scopes: [],
          display_connected: true,
          display_held_scopes: ['delete:objects'],
        },
        {
          id: 'ws_3',
          name: 'Initech',
          role: 'member',
          connected: false,
          held_scopes: [],
          display_connected: true,
          display_held_scopes: ['delete:objects', 'handbook:write'],
        },
      ],
    }

    renderPage(stubs)
    await screen.findByText('Connect Example Agent')

    // The facts, as words.
    expect(screen.getAllByText('· connected now')).toHaveLength(2)
    expect(box(/^Globex/u).closest('label')?.textContent).toContain('connected now')
    expect(box(/^Acme/u).closest('label')?.textContent).not.toContain('connected now')
    expect(
      screen.getByText('Allowed now in Globex, Initech. Tick it to allow it in the workspaces you select.'),
    ).toBeTruthy()
    expect(screen.getByText('Allowed now in Initech. Tick it to allow it in the workspaces you select.')).toBeTruthy()

    // The ticks, as for an app that is new: the workspace of the session, and no extra.
    expect(box(/^Acme/u).checked).toBe(true)
    expect(box(/^Globex/u).checked).toBe(false)
    expect(box(/^Initech/u).checked).toBe(false)

    for (const name of [/^Decisions \(commit/u, /^Handbook \(write\)/u, /^Delete objects/u]) {
      expect(box(name).checked).toBe(false)
      expect(box(name).disabled).toBe(false)
    }

    expect(screen.queryByText(/· already allowed/u)).toBeNull()

    // Ticking the connected workspaces does not tick what they hold either.
    await act(async () => {
      box(/^Globex/u).click()
    })
    await act(async () => {
      box(/^Initech/u).click()
    })

    expect(box(/^Delete objects/u).checked).toBe(false)

    cleanup()

    expect(await approveAfter(stubs, [])).toEqual({ workspace_ids: ['ws_1'], scopes: ['read:objects', 'write:objects'] })

    cleanup()

    expect(await approveAfter(stubs, [/^Globex/u, /^Delete objects/u])).toEqual({
      workspace_ids: ['ws_1', 'ws_2'],
      scopes: ['read:objects', 'write:objects', 'delete:objects'],
    })
  })

  it('shows the display fields of an app that does not run on this computer in no place of their own', async () => {
    renderPage({
      extraScopes: ALL_EXTRAS,
      workspaces: [
        {
          id: 'ws_1',
          name: 'Acme',
          role: 'owner',
          connected: true,
          held_scopes: ['delete:objects'],
          display_connected: true,
          display_held_scopes: ['delete:objects'],
        },
      ],
    })
    await screen.findByText('Connect Example Agent')

    // The tick and its "already allowed" mark say it. The local-client words are not used.
    expect(box(/^Delete objects/u).checked).toBe(true)
    expect(screen.queryByText('· connected now')).toBeNull()
    expect(screen.queryByText(/^Allowed now in/u)).toBeNull()
  })

  it('does not show that line for an app that does not run on this computer', async () => {
    renderPage({ extraScopes: ALL_EXTRAS })
    await screen.findByText('Connect Example Agent')

    expect(screen.queryByText(/This app runs on your computer/u)).toBeNull()
  })

  it('says where an extra is allowed now when only some of the ticked workspaces have it', async () => {
    const stubs = {
      extraScopes: ALL_EXTRAS,
      workspaces: [
        { id: 'ws_1', name: 'Acme', role: 'owner', connected: true, held_scopes: ['delete:objects'] },
        { id: 'ws_2', name: 'Globex', role: 'member', connected: true, held_scopes: [] },
      ],
    }

    renderPage(stubs)
    await screen.findByText('Connect Example Agent')

    // Both are ticked, one holds the scope, so the row starts clear and says what a plain Allow does.
    expect(box(/^Delete objects/u).checked).toBe(false)
    expect(screen.getByText('Allowed now in Acme. If you leave it clear, it is removed there.')).toBeTruthy()
    // A row that no ticked workspace holds has no such note.
    expect(screen.getAllByText(/^Allowed now in/u)).toHaveLength(1)

    await act(async () => {
      box(/^Delete objects/u).click()
    })

    expect(screen.getByText('Allowed now in Acme. Ticked, it is allowed in every selected workspace.')).toBeTruthy()

    await act(async () => {
      box(/Globex/u).click()
    })

    // Only Acme is ticked now, and it holds the scope: nothing is partial.
    expect(screen.queryByText(/^Allowed now in/u)).toBeNull()
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
