import { QueryClient } from '@tanstack/react-query'
import { cleanup, render, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, describe, expect, it } from 'vitest'

import { ApiProvider } from '../api/ApiProvider.tsx'
import type { ApiClient } from '../api/client.ts'
import { UiExtensionProvider } from '../registry/UiExtensionProvider.tsx'
import { registerUiModules } from '../registry/registry.ts'
import { stubClient } from '../testing/stubClient.ts'
import { Shell } from './Shell.tsx'

afterEach(cleanup)

/**
 * The shell sidebar swaps between the main app menu and the admin menu based on
 * the current route. These cover both modes and the back link that returns to
 * the main menu.
 */

const SESSION = {
  user_id: 'usr_1',
  session_id: 'ses_1',
  workspace_id: 'ws_1',
  role: 'owner',
  email_verified: true,
}

const ACCOUNT = {
  id: 'usr_1',
  email: 'ada@example.com',
  name: 'Ada Lovelace',
  email_verified: true,
}

const PREFERENCES = {
  timezone: 'UTC',
  theme: 'system',
  email_digest: true,
  mention_emails: true,
  product_updates: true,
  list_views: {},
}

function shellClient(): ApiClient {
  return stubClient({
    get: (path) => {
      if (path === '/auth/me') {
        return SESSION
      }

      if (path === '/account') {
        return ACCOUNT
      }

      if (path === '/account/preferences') {
        return PREFERENCES
      }

      throw new Error(`Unexpected get ${path}`)
    },
    list: (path) => {
      if (path === '/workspaces/ws_1/modules') {
        return { items: [], nextCursor: null }
      }

      throw new Error(`Unexpected list ${path}`)
    },
  })
}

function sidebarLinkLabels(): readonly string[] {
  const nav = document.querySelector('aside nav')

  if (nav === null) {
    throw new Error('sidebar nav not found')
  }

  return Array.from(nav.querySelectorAll('a')).map((link) => link.textContent ?? '')
}

function renderShell(initialPath: string): void {
  render(
    <ApiProvider
      baseUrl="http://localhost/v1"
      client={shellClient()}
      queryClient={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <UiExtensionProvider extensions={registerUiModules([])}>
        <MemoryRouter initialEntries={[initialPath]}>
          <Routes>
            <Route element={<Shell />}>
              <Route path="dashboard" element={<p>Dashboard page</p>} />
              <Route path="admin/team" element={<p>Team page</p>} />
            </Route>
          </Routes>
        </MemoryRouter>
      </UiExtensionProvider>
    </ApiProvider>,
  )
}

describe('the shell sidebar', () => {
  it('shows the main menu on app routes', async () => {
    renderShell('/dashboard')

    await waitFor(() => {
      const labels = sidebarLinkLabels()

      expect(labels).toContain('Dashboard')
      expect(labels).toContain('People')
      expect(labels).toContain('Admin')
      expect(labels).not.toContain('Workspace')
      expect(labels).not.toContain('← Back')
    })
  })

  it('shows the admin menu on admin routes', async () => {
    renderShell('/admin/team')

    await waitFor(() => {
      const labels = sidebarLinkLabels()

      expect(labels).toContain('← Back')
      expect(labels).toContain('Workspace')
      expect(labels).toContain('Team')
      expect(labels).not.toContain('Dashboard')
      expect(labels).not.toContain('People')
    })
  })
})
