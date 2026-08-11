import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, describe, expect, it } from 'vitest'

import { UiExtensionProvider } from '../../registry/UiExtensionProvider.tsx'
import { registerUiModules } from '../../registry/registry.ts'
import type { UiExtensions, UiModule } from '../../registry/registry.ts'
import { AccountLayout } from './AccountLayout.tsx'

afterEach(cleanup)

/**
 * The account tab strip, and the `nav.account` slot it renders.
 *
 * That slot was declared in `modules.md` and read by nobody: `Shell.tsx` asks
 * for `primary` and `admin` only, so a module contributing an account tab got a
 * page with no way in. These assert the fix, and the ordering rule that lets a
 * module land between two core tabs.
 */

const integrationsModule: UiModule = {
  id: 'integrations',

  register(context) {
    context.nav('account', {
      id: 'integrations',
      label: 'Integrations',
      to: '/account/integrations',
      order: 250,
    })
  },
}

function renderWith(extensions: UiExtensions): void {
  render(
    <UiExtensionProvider extensions={extensions}>
      <MemoryRouter initialEntries={['/account/profile']}>
        <Routes>
          <Route path="account" element={<AccountLayout />}>
            <Route path="profile" element={<p>Profile page</p>} />
          </Route>
        </Routes>
      </MemoryRouter>
    </UiExtensionProvider>,
  )
}

function tabLabels(): readonly string[] {
  return screen.getAllByRole('link').map((link) => link.textContent ?? '')
}

describe('the account tab strip', () => {
  it('shows core tabs and nothing else when no module contributes one', () => {
    renderWith(registerUiModules([]))

    expect(tabLabels()).toEqual(['Profile', 'Security', 'Preferences'])
  })

  it('renders a module tab from the account nav slot', () => {
    renderWith(registerUiModules([integrationsModule]))

    expect(tabLabels()).toContain('Integrations')
  })

  /**
   * 250 puts it between Security (200) and Preferences (300). Core numbering in
   * hundreds is what makes that possible without core renumbering, so an
   * appended-to-the-end result would mean the order was being ignored.
   */
  it('places a module tab by its order among the core ones', () => {
    renderWith(registerUiModules([integrationsModule]))

    expect(tabLabels()).toEqual(['Profile', 'Security', 'Integrations', 'Preferences'])
  })

  it('still renders the page inside the strip', () => {
    renderWith(registerUiModules([integrationsModule]))

    expect(screen.getByText('Profile page')).toBeDefined()
  })
})
