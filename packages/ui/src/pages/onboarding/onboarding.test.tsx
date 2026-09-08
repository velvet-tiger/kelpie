import { QueryClient } from '@tanstack/react-query'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useSearchParams } from 'react-router'
import { afterEach, describe, expect, it } from 'vitest'

import { ApiProvider } from '../../api/ApiProvider.tsx'
import { ApiError } from '../../api/client.ts'
import type { ApiClient } from '../../api/client.ts'
import { stubClient } from '../../testing/stubClient.ts'
import { HandbookStepPage } from './HandbookStepPage.tsx'
import { InvitesStepPage } from './InvitesStepPage.tsx'
import { ModulesStepPage } from './ModulesStepPage.tsx'
import { OrganisationStepPage } from './OrganisationStepPage.tsx'
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
  patched: { path: string; body: unknown }[]
}

interface Stubs {
  readonly workspaceId?: string | null
  readonly pages?: readonly Record<string, unknown>[]
  /** Addresses the service refuses, so a row can fail while its neighbours do not. */
  readonly rejectEmails?: readonly string[]
  /** `GET /auth/me` answers `401`: nobody is signed in. */
  readonly signedOut?: boolean
  /** Module ids whose PATCH the service refuses, so the step cannot advance. */
  readonly rejectModules?: readonly string[]
}

function onboardingClient(calls: Calls, stubs: Stubs = {}): ApiClient {
  const session = {
    user_id: 'usr_1',
    session_id: 'ses_1',
    workspace_id: stubs.workspaceId === undefined ? 'wsp_1' : stubs.workspaceId,
    role: 'owner',
    email_verified: true,
  }
  const handbookPagesState: Record<string, unknown>[] =
    stubs.pages === undefined ? [] : [...stubs.pages]

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

      return { items: handbookPagesState, nextCursor: null }
    },
    post: (path, body) => {
      calls.posted.push({ path, body })

      if (path === '/workspaces') {
        return WORKSPACE
      }

      if (path.endsWith('/handbook/seed')) {
        const template = (body as { handbook_template: string }).handbook_template
        handbookPagesState.splice(0, handbookPagesState.length)

        if (template === 'nonprofit') {
          handbookPagesState.push(handbookPage('hbp_1', 'Programs & impact'))
        } else {
          handbookPagesState.push(handbookPage('hbp_1', 'About us'))
        }

        return { handbook_pages: handbookPagesState.length }
      }

      if (path.endsWith('/sample-data')) {
        return {
          companies: 5,
          people: 5,
          positions: 5,
          deals: 3,
          plan_items: 3,
          notes: 3,
          opportunities: 3,
          raises: 1,
          partnerships: 2,
          enquiries: 2,
          roles: 2,
          candidates: 3,
          events: 2,
          attendances: 4,
        }
      }

      const sent = body as { email: string; role: string }

      if (stubs.rejectEmails?.includes(sent.email) === true) {
        return Promise.reject(new ApiError(409, 'conflict', 'That person is already a member'))
      }

      return invite(sent.email, sent.role)
    },
    patch: (path, body) => {
      calls.patched.push({ path, body })

      const moduleId = path.split('/').at(-1) ?? ''

      if (stubs.rejectModules?.includes(moduleId) === true) {
        return Promise.reject(new ApiError(409, 'conflict', 'This module is locked by the deployment configuration'))
      }

      const enabled = (body as { enabled: boolean }).enabled

      return { module_id: moduleId, enabled, locked: false }
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

function StepEcho({ label }: { label: string }): React.JSX.Element {
  const [params] = useSearchParams()
  const org = params.get('org')

  return (
    <div>
      <p>{label}</p>
      {org !== null && <p>{`org=${org}`}</p>}
    </div>
  )
}

function renderStep(
  element: React.JSX.Element,
  calls: Calls,
  stubs: Stubs = {},
  initialPath = '/step',
): void {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })

  render(
    <MemoryRouter initialEntries={[initialPath]}>
      <ApiProvider client={onboardingClient(calls, stubs)} queryClient={queryClient}>
        <Routes>
          <Route path="/step" element={element} />
          {/* Standing in for what each step hands off to, so moving on is
              something the test can see. */}
          <Route path="/onboarding/workspace" element={<p>step 1</p>} />
          <Route path="/onboarding/organisation" element={<StepEcho label="step 2" />} />
          <Route path="/onboarding/modules" element={<StepEcho label="step 3" />} />
          <Route path="/onboarding/invites" element={<StepEcho label="step 4" />} />
          <Route path="/onboarding/handbook" element={<p>step 5</p>} />
          <Route path="/dashboard" element={<p>the app</p>} />
          <Route path="/login" element={<p>sign in</p>} />
        </Routes>
      </ApiProvider>
    </MemoryRouter>,
  )
}

function noCalls(): Calls {
  return { posted: [], patched: [] }
}

describe('WorkspaceStepPage', () => {
  it('derives the slug from the name and creates the workspace', async () => {
    const calls = noCalls()

    renderStep(<WorkspaceStepPage />, calls, { workspaceId: null })

    await act(async () => {
      setValue(screen.getByLabelText(/^Workspace name/u), 'Acme Labs')
    })

    expect((screen.getByLabelText(/^Slug/u) as HTMLInputElement).value).toBe('acme-labs')

    await press('Next')

    await waitFor(() => {
      expect(calls.posted).toHaveLength(1)
    })

    const body = calls.posted[0]?.body as Record<string, string>

    expect(calls.posted[0]?.path).toBe('/workspaces')
    expect(body.name).toBe('Acme Labs')
    expect(body.slug).toBe('acme-labs')
    expect(body.handbook_template).toBeUndefined()
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

  it('creates the workspace without seeding', async () => {
    const calls = noCalls()

    renderStep(<WorkspaceStepPage />, calls, { workspaceId: null })

    await act(async () => {
      setValue(screen.getByLabelText(/^Workspace name/u), 'Acme Labs')
    })

    await press('Next')

    await waitFor(() => {
      expect(calls.posted).toHaveLength(1)
    })

    expect(calls.posted[0]?.path).toBe('/workspaces')
    expect(calls.patched).toEqual([])
  })

  it('has no Previous button: there is no earlier onboarding step', async () => {
    renderStep(<WorkspaceStepPage />, noCalls(), { workspaceId: null })

    expect(await screen.findByRole('button', { name: 'Next' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Previous' })).toBeNull()
  })

  /**
   * Previous on a later step lands here after POST /workspaces has already
   * succeeded. The create form must not come back.
   */
  it('moves on when the account already has a workspace', async () => {
    renderStep(<WorkspaceStepPage />, noCalls())

    expect(await screen.findByText('Your workspace is ready')).toBeTruthy()
    expect(screen.queryByLabelText(/^Workspace name/u)).toBeNull()

    await press('Next')

    expect(await screen.findByText('step 2')).toBeTruthy()
  })

  /**
   * A finished workspace can walk the wizard again. Organisation still runs;
   * handbook pages are not seeded from that step, and the review is skipped.
   */
  it('keeps organisation on a rerun', async () => {
    renderStep(<WorkspaceStepPage />, noCalls(), {}, '/step?rerun=1')

    expect(await screen.findByText('Your workspace is ready')).toBeTruthy()

    await press('Next')

    expect(await screen.findByText('step 2')).toBeTruthy()
    expect(screen.queryByText('step 3')).toBeNull()
  })
})

describe('OrganisationStepPage', () => {
  it('renders the organisation type choices including Choose later', async () => {
    renderStep(<OrganisationStepPage />, noCalls(), { pages: [] })

    expect(await screen.findByText('Startup')).toBeTruthy()
    expect(screen.getByText('Agency')).toBeTruthy()
    expect(screen.getByText('Nonprofit')).toBeTruthy()
    expect(screen.getByText('Choose later')).toBeTruthy()
  })

  it('seeds the handbook for the default organisation type then moves on', async () => {
    const calls = noCalls()

    renderStep(<OrganisationStepPage />, calls, { pages: [] })

    await screen.findByRole('button', { name: 'Next' })
    await press('Next')

    await waitFor(() => {
      expect(calls.posted.some((call) => call.path === '/workspaces/wsp_1/handbook/seed')).toBe(true)
    })

    const seed = calls.posted.find((call) => call.path === '/workspaces/wsp_1/handbook/seed')

    expect(await screen.findByText('step 3')).toBeTruthy()
    expect(screen.getByText('org=startup')).toBeTruthy()
    expect((seed?.body as { handbook_template: string }).handbook_template).toBe('startup')
  })

  it('seeds the startup handbook when Choose later is selected', async () => {
    const calls = noCalls()

    renderStep(<OrganisationStepPage />, calls, { pages: [] })

    await screen.findByLabelText(/^Choose later/u)

    await act(async () => {
      screen.getByLabelText(/^Choose later/u).click()
    })

    await press('Next')

    await waitFor(() => {
      expect(calls.posted).toHaveLength(1)
    })

    expect((calls.posted[0]?.body as { handbook_template: string }).handbook_template).toBe('startup')
    expect(await screen.findByText('step 3')).toBeTruthy()
    expect(screen.getByText('org=later')).toBeTruthy()
  })

  it('seeds a different template when Nonprofit is selected', async () => {
    const calls = noCalls()

    renderStep(<OrganisationStepPage />, calls, { pages: [] })

    await screen.findByLabelText(/^Nonprofit/u)

    await act(async () => {
      screen.getByLabelText(/^Nonprofit/u).click()
    })

    await press('Next')

    await waitFor(() => {
      expect(calls.posted).toHaveLength(1)
    })

    expect((calls.posted[0]?.body as { handbook_template: string }).handbook_template).toBe(
      'nonprofit',
    )
    expect(await screen.findByText('step 3')).toBeTruthy()
    expect(screen.getByText('org=nonprofit')).toBeTruthy()
  })

  it('replaces existing starter pages when going through the step again', async () => {
    const calls = noCalls()

    renderStep(<OrganisationStepPage />, calls, {
      pages: [handbookPage('hbp_1', 'About us')],
    })

    await screen.findByLabelText(/^Nonprofit/u)

    await act(async () => {
      screen.getByLabelText(/^Nonprofit/u).click()
    })

    await press('Next')

    await waitFor(() => {
      expect(calls.posted).toHaveLength(1)
    })

    const body = calls.posted[0]?.body as { handbook_template: string; replace: boolean }

    expect(body.handbook_template).toBe('nonprofit')
    expect(body.replace).toBe(true)
  })

  it('goes back to the workspace step without seeding', async () => {
    const calls = noCalls()

    renderStep(<OrganisationStepPage />, calls, { pages: [] })

    await screen.findByRole('button', { name: 'Next' })
    await press('Previous')

    expect(await screen.findByText('step 1')).toBeTruthy()
    expect(calls.posted).toEqual([])
  })

  it('shows the choices on a rerun and moves on without seeding', async () => {
    const calls = noCalls()

    renderStep(
      <OrganisationStepPage />,
      calls,
      { pages: [handbookPage('hbp_1', 'About us')] },
      '/step?rerun=1',
    )

    expect(await screen.findByText('Startup')).toBeTruthy()
    expect(screen.getByText('Pick a type to continue.')).toBeTruthy()
    expect(screen.queryByText(/Existing handbook pages/u)).toBeNull()

    await act(async () => {
      screen.getByLabelText(/^Nonprofit/u).click()
    })
    await press('Next')

    expect(await screen.findByText('step 3')).toBeTruthy()
    expect(screen.getByText('org=nonprofit')).toBeTruthy()
    expect(calls.posted).toEqual([])
  })
})

describe('ModulesStepPage', () => {
  it('starts with every optional module on for a startup', async () => {
    renderStep(<ModulesStepPage />, noCalls())

    expect(((await screen.findByLabelText(/^Deals/u)) as HTMLInputElement).checked).toBe(true)
    expect((screen.getByLabelText(/^Opportunities/u) as HTMLInputElement).checked).toBe(true)
    expect((screen.getByLabelText(/^Fundraising/u) as HTMLInputElement).checked).toBe(true)
    expect((screen.getByLabelText(/^Partnerships/u) as HTMLInputElement).checked).toBe(true)
    expect((screen.getByLabelText(/^Events/u) as HTMLInputElement).checked).toBe(true)
    expect((screen.getByLabelText(/^Forms/u) as HTMLInputElement).checked).toBe(true)
  })

  it('starts with opportunities off for an agency', async () => {
    renderStep(<ModulesStepPage />, noCalls(), {}, '/step?org=agency')

    expect(((await screen.findByLabelText(/^Deals/u)) as HTMLInputElement).checked).toBe(true)
    expect((screen.getByLabelText(/^Opportunities/u) as HTMLInputElement).checked).toBe(false)
    expect((screen.getByLabelText(/^Fundraising/u) as HTMLInputElement).checked).toBe(false)
    expect((screen.getByLabelText(/^Partnerships/u) as HTMLInputElement).checked).toBe(true)
    expect((screen.getByLabelText(/^Events/u) as HTMLInputElement).checked).toBe(true)
    expect((screen.getByLabelText(/^Forms/u) as HTMLInputElement).checked).toBe(true)
    expect(screen.getByText('Track pitches, retainers, and projects you are trying to close.')).toBeTruthy()
    expect(screen.getByText('Suggested for Agency. Turn the rest on whenever you like — nothing here is permanent.')).toBeTruthy()
  })

  it('starts with fundraising on for a nonprofit', async () => {
    renderStep(<ModulesStepPage />, noCalls(), {}, '/step?org=nonprofit')

    expect(((await screen.findByLabelText(/^Deals/u)) as HTMLInputElement).checked).toBe(false)
    expect((screen.getByLabelText(/^Fundraising/u) as HTMLInputElement).checked).toBe(true)
    expect((screen.getByLabelText(/^Partnerships/u) as HTMLInputElement).checked).toBe(true)
    expect(screen.getByText('Chase grants, awards, press, and speaking slots.')).toBeTruthy()
    expect(
      screen.getByText('Track who you are raising from, and where each conversation is up to.'),
    ).toBeTruthy()
  })

  it('starts with fundraising on for a community', async () => {
    renderStep(<ModulesStepPage />, noCalls(), {}, '/step?org=community')

    expect(((await screen.findByLabelText(/^Deals/u)) as HTMLInputElement).checked).toBe(false)
    expect((screen.getByLabelText(/^Fundraising/u) as HTMLInputElement).checked).toBe(true)
    expect((screen.getByLabelText(/^Events/u) as HTMLInputElement).checked).toBe(true)
  })

  it('starts with opportunities and partnerships off for professional services', async () => {
    renderStep(<ModulesStepPage />, noCalls(), {}, '/step?org=professional-services')

    expect(((await screen.findByLabelText(/^Deals/u)) as HTMLInputElement).checked).toBe(true)
    expect((screen.getByLabelText(/^Opportunities/u) as HTMLInputElement).checked).toBe(false)
    expect((screen.getByLabelText(/^Partnerships/u) as HTMLInputElement).checked).toBe(false)
    expect((screen.getByLabelText(/^Events/u) as HTMLInputElement).checked).toBe(true)
    expect((screen.getByLabelText(/^Forms/u) as HTMLInputElement).checked).toBe(true)
  })

  it('starts with partnerships and events off for a creator', async () => {
    renderStep(<ModulesStepPage />, noCalls(), {}, '/step?org=creator')

    expect(((await screen.findByLabelText(/^Deals/u)) as HTMLInputElement).checked).toBe(true)
    expect((screen.getByLabelText(/^Opportunities/u) as HTMLInputElement).checked).toBe(true)
    expect((screen.getByLabelText(/^Partnerships/u) as HTMLInputElement).checked).toBe(false)
    expect((screen.getByLabelText(/^Events/u) as HTMLInputElement).checked).toBe(false)
    expect((screen.getByLabelText(/^Forms/u) as HTMLInputElement).checked).toBe(true)
    expect(
      screen.getByText('Track brand deals and client work from first chat to won or lost.'),
    ).toBeTruthy()
  })

  it('writes agency defaults when that type is on the query', async () => {
    const calls = noCalls()

    renderStep(<ModulesStepPage />, calls, {}, '/step?org=agency')

    await screen.findByRole('button', { name: 'Next' })

    await press('Next')

    await waitFor(() => {
      expect(calls.patched).toHaveLength(6)
    })

    expect(calls.patched.map((call) => (call.body as { enabled: boolean }).enabled)).toEqual([
      true,
      false,
      false,
      true,
      true,
      true,
    ])
    expect(await screen.findByText('step 4')).toBeTruthy()
    expect(screen.getByText('org=agency')).toBeTruthy()
  })

  it('writes every module choice then moves on', async () => {
    const calls = noCalls()

    renderStep(<ModulesStepPage />, calls)

    await screen.findByRole('button', { name: 'Next' })

    await press('Next')

    await waitFor(() => {
      expect(calls.patched).toHaveLength(6)
    })

    expect(calls.patched.map((call) => call.path)).toEqual([
      '/workspaces/wsp_1/modules/deals',
      '/workspaces/wsp_1/modules/opportunities',
      '/workspaces/wsp_1/modules/raises',
      '/workspaces/wsp_1/modules/partnerships',
      '/workspaces/wsp_1/modules/events',
      '/workspaces/wsp_1/modules/forms',
    ])
    expect(calls.patched.map((call) => (call.body as { enabled: boolean }).enabled)).toEqual([
      true,
      true,
      true,
      true,
      true,
      true,
    ])
    expect(calls.posted).toEqual([])
    expect(await screen.findByText('step 4')).toBeTruthy()
  })

  it('installs the sample fixture after the module choices when the checkbox is on', async () => {
    const calls = noCalls()

    renderStep(<ModulesStepPage />, calls)

    await screen.findByRole('button', { name: 'Next' })

    await act(async () => {
      screen.getByLabelText(/sample data/u).click()
    })

    await press('Next')

    await waitFor(() => {
      expect(calls.posted).toHaveLength(1)
    })

    expect(calls.patched).toHaveLength(6)
    expect(calls.posted[0]?.path).toBe('/workspaces/wsp_1/sample-data')
    expect(await screen.findByText('step 4')).toBeTruthy()
  })

  it('stays on the page when a module write is refused', async () => {
    const calls = noCalls()

    renderStep(<ModulesStepPage />, calls, { rejectModules: ['deals'] })

    await screen.findByRole('button', { name: 'Next' })

    await press('Next')

    expect(await screen.findByText('This module is locked by the deployment configuration')).toBeTruthy()
    expect(screen.queryByText('step 4')).toBeNull()
    expect(calls.posted).toEqual([])
  })

  it('goes back to the organisation step without writing', async () => {
    const calls = noCalls()

    renderStep(<ModulesStepPage />, calls)

    await screen.findByRole('button', { name: 'Next' })
    await press('Previous')

    expect(await screen.findByText('step 2')).toBeTruthy()
    expect(calls.patched).toEqual([])
    expect(calls.posted).toEqual([])
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
    // The invite link is built server-side now, so the browser sends no URL.
    expect(bodies[0]?.invite_url_template).toBeUndefined()

    expect(await screen.findByText('step 5')).toBeTruthy()
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
    expect(screen.queryByText('step 5')).toBeNull()

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

    expect(await screen.findByText('step 5')).toBeTruthy()
    expect(calls.posted).toEqual([])
  })

  /** A rerun leaves handbook pages alone and returns to the app. */
  it('skips the handbook step on a rerun', async () => {
    const calls = noCalls()

    renderStep(<InvitesStepPage />, calls, {}, '/step?rerun=1')

    await press('Skip for now')

    expect(await screen.findByText('the app')).toBeTruthy()
    expect(screen.queryByText('step 5')).toBeNull()
    expect(calls.posted).toEqual([])
  })

  it('goes back to the modules step without sending', async () => {
    const calls = noCalls()

    renderStep(<InvitesStepPage />, calls)

    await press('Previous')

    expect(await screen.findByText('step 3')).toBeTruthy()
    expect(calls.posted).toEqual([])
  })
})

describe('HandbookStepPage', () => {
  /**
   * The pages already exist: step 2 seeded them. This step reads them back.
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

  it('goes back to the invites step', async () => {
    renderStep(<HandbookStepPage />, noCalls(), {
      pages: [handbookPage('hbp_1', 'About us')],
    })

    expect(await screen.findByText('About us')).toBeTruthy()
    await press('Previous')

    expect(await screen.findByText('step 4')).toBeTruthy()
  })

  it('sends a rerun straight to the app', async () => {
    renderStep(
      <HandbookStepPage />,
      noCalls(),
      { pages: [handbookPage('hbp_1', 'About us')] },
      '/step?rerun=1',
    )

    expect(await screen.findByText('the app')).toBeTruthy()
    expect(screen.queryByText('About us')).toBeNull()
  })
})
