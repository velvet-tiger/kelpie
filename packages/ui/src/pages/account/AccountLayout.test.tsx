import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, describe, expect, it } from 'vitest'

import { ApiProvider } from '../../api/ApiProvider.tsx'
import type { ApiClient } from '../../api/client.ts'
import { UiExtensionProvider } from '../../registry/UiExtensionProvider.tsx'
import { registerUiModules } from '../../registry/registry.ts'
import type { UiModule } from '../../registry/registry.ts'
import { stubClient } from '../../testing/stubClient.ts'
import { AccountLayout } from './AccountLayout.tsx'

afterEach(cleanup)

/**
 * The account tab strip, and the `nav.account` slot it renders.
 *
 * That slot was declared in `modules.md` and read by nobody: `Shell.tsx` asks
 * for `primary` and `admin` only, so a module contributing an account tab got a
 * page with no way in. These cover the fix, the ordering rule that lets a
 * module land between two core tabs, and the case that made the shell and this
 * strip worth sharing one hook: a module switched off in workspace settings
 * disappears from both.
 */

const mailboxModule: UiModule = {
  id: 'gmail-sync',

  register(context) {
    context.nav('account', {
      id: 'gmail-sync',
      label: 'Mailbox',
      to: '/account/mailbox',
      order: 250,
    })
  },
}

interface Stubs {
  /** Module ids the workspace has switched off. */
  readonly disabled?: readonly string[]
}

function accountClient(stubs: Stubs): ApiClient {
  return stubClient({
    get: (path) => {
      if (path !== '/auth/me') {
        throw new Error(`Unexpected get ${path}`)
      }

      return {
        user_id: 'usr_1',
        session_id: 'ses_1',
        workspace_id: 'ws_1',
        role: 'owner',
        email_verified: true,
      }
    },
    list: (path) => {
      if (path !== '/workspaces/ws_1/modules') {
        throw new Error(`Unexpected list ${path}`)
      }

      const disabled = stubs.disabled ?? []

      return {
        items: ['gmail-sync', 'raises'].map((moduleId) => ({
          module_id: moduleId,
          enabled: !disabled.includes(moduleId),
          locked: false,
        })),
        nextCursor: null,
      }
    },
  })
}

function renderWith(modules: readonly UiModule[], stubs: Stubs = {}): void {
  render(
    <ApiProvider baseUrl="http://localhost/v1" client={accountClient(stubs)}>
      <UiExtensionProvider extensions={registerUiModules(modules)}>
        <MemoryRouter initialEntries={['/account/profile']}>
          <Routes>
            <Route path="account" element={<AccountLayout />}>
              <Route path="profile" element={<p>Profile page</p>} />
            </Route>
          </Routes>
        </MemoryRouter>
      </UiExtensionProvider>
    </ApiProvider>,
  )
}

function tabLabels(): readonly string[] {
  return screen.getAllByRole('link').map((link) => link.textContent ?? '')
}

describe('the account tab strip', () => {
  it('shows core tabs and nothing else when no module contributes one', async () => {
    renderWith([])

    await waitFor(() => {
      expect(tabLabels()).toEqual(['Profile', 'Security', 'Preferences', 'API keys'])
    })
  })

  /**
   * 250 puts it between Security (200) and Preferences (300). Core numbering in
   * hundreds is what makes that possible without core renumbering, so an
   * appended-to-the-end result would mean the order was being ignored.
   */
  it('places a module tab by its order among the core ones', async () => {
    renderWith([mailboxModule])

    await waitFor(() => {
      expect(tabLabels()).toEqual(['Profile', 'Security', 'Mailbox', 'Preferences', 'API keys'])
    })
  })

  it('drops a module tab when the workspace has switched that module off', async () => {
    renderWith([mailboxModule], { disabled: ['gmail-sync'] })

    await waitFor(() => {
      expect(tabLabels()).toEqual(['Profile', 'Security', 'Preferences', 'API keys'])
    })
  })

  it('still renders the page inside the strip', async () => {
    renderWith([mailboxModule])

    await waitFor(() => {
      expect(screen.getByText('Profile page')).toBeDefined()
    })
  })
})
