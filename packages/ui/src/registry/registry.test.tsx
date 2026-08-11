import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { UiExtensionProvider } from './UiExtensionProvider.tsx'
import {
  useDashboardCards,
  useModuleRoutes,
  useNavItems,
  useOverridable,
  useRecordTabs,
} from './context.ts'
import { defineOverridable } from './overridable.ts'
import { NO_UI_MODULES, UiModuleError, inSlotOrder, registerUiModules } from './registry.ts'
import type { UiExtensions, UiModule } from './registry.ts'

afterEach(cleanup)

/**
 * A core component a module may replace, standing in for the ones the UI port
 * will define. What matters is the shape: core hands out a token, core renders
 * through it, and a module can swap what comes out.
 */
interface RecordHeaderProps {
  readonly title: string
}

const recordHeader = defineOverridable<RecordHeaderProps>('record.header', ({ title }) => (
  <h2>Core header: {title}</h2>
))

/**
 * Stands in for the shell until the UI port lands. Every slot the registry
 * offers is read here, so a slot that renders something when it should be empty
 * shows up as text that should not be on the page.
 */
function TestShell(): React.JSX.Element {
  const RecordHeader = useOverridable(recordHeader)

  return (
    <div>
      <nav>
        {useNavItems('primary').map((item) => (
          <a key={item.id} href={item.to}>
            {item.label}
          </a>
        ))}
      </nav>
      <RecordHeader title="Ada Lovelace" />
      <section aria-label="tabs">
        {useRecordTabs('person').map((tab) => (
          <div key={tab.id}>{tab.render({ objectType: 'person', recordId: 'per_1' })}</div>
        ))}
      </section>
      <section aria-label="dashboard">
        {useDashboardCards().map((card) => (
          <div key={card.id}>{card.render()}</div>
        ))}
      </section>
      <section aria-label="routes">
        {useModuleRoutes().map((route) => (
          <span key={route.path}>{route.path}</span>
        ))}
      </section>
    </div>
  )
}

/** One module exercising every slot, the way a real module would. */
const gmailModule: UiModule = {
  id: 'gmail-sync',

  register(context) {
    context.nav('primary', { id: 'gmail', label: 'Gmail', to: '/gmail', order: 250 })
    context.route({ path: '/gmail', element: <p>Gmail settings</p> })
    context.recordTab('person', {
      id: 'gmail-thread',
      label: 'Email',
      render: (record) => <p>Threads for {record.recordId}</p>,
    })
    context.recordSidebarCard('person', {
      id: 'gmail-last-seen',
      render: () => <p>Last emailed yesterday</p>,
    })
    context.dashboardCard({ id: 'gmail-unread', render: () => <p>Twelve unread</p> })
    context.override(recordHeader, ({ title }) => <h2>Gmail header: {title}</h2>)
  },
}

function renderWith(extensions: UiExtensions): void {
  render(
    <UiExtensionProvider extensions={extensions}>
      <TestShell />
    </UiExtensionProvider>,
  )
}

describe('an assembly with no UI modules', () => {
  it('has an empty slot of every kind', () => {
    expect(NO_UI_MODULES.navItems('primary')).toEqual([])
    expect(NO_UI_MODULES.navItems('admin')).toEqual([])
    expect(NO_UI_MODULES.routes()).toEqual([])
    expect(NO_UI_MODULES.recordTabs('person')).toEqual([])
    expect(NO_UI_MODULES.recordSidebarCards('company')).toEqual([])
    expect(NO_UI_MODULES.dashboardCards()).toEqual([])
    expect(NO_UI_MODULES.navItems('account')).toEqual([])
  })

  it('renders core components, and nothing where the slots are', () => {
    renderWith(NO_UI_MODULES)

    expect(screen.getByText('Core header: Ada Lovelace')).toBeDefined()
    expect(screen.getByRole('navigation').textContent).toBe('')
    expect(screen.getByLabelText('tabs').textContent).toBe('')
    expect(screen.getByLabelText('dashboard').textContent).toBe('')
  })

  /** A tree with no provider is the same as one with no modules, so a page needs no setup to look right. */
  it('needs no provider to look the same', () => {
    render(<TestShell />)

    expect(screen.getByText('Core header: Ada Lovelace')).toBeDefined()
    expect(screen.getByRole('navigation').textContent).toBe('')
  })
})

describe('a registered module', () => {
  it('reaches every slot it contributed to', () => {
    const extensions = registerUiModules([gmailModule])

    expect(extensions.navItems('primary').map((item) => item.label)).toEqual(['Gmail'])
    expect(extensions.routes().map((route) => route.path)).toEqual(['/gmail'])
    expect(extensions.recordTabs('person').map((tab) => tab.label)).toEqual(['Email'])
    expect(extensions.recordSidebarCards('person').map((card) => card.id)).toEqual(['gmail-last-seen'])
    expect(extensions.dashboardCards().map((card) => card.id)).toEqual(['gmail-unread'])
  })

  it('renders into the shell', () => {
    renderWith(registerUiModules([gmailModule]))

    expect(screen.getByRole('link', { name: 'Gmail' }).getAttribute('href')).toBe('/gmail')
    expect(screen.getByText('Threads for per_1')).toBeDefined()
    expect(screen.getByText('Twelve unread')).toBeDefined()
  })

  it('replaces a core component, and still gets the props core passes', () => {
    renderWith(registerUiModules([gmailModule]))

    expect(screen.getByText('Gmail header: Ada Lovelace')).toBeDefined()
    expect(screen.queryByText('Core header: Ada Lovelace')).toBeNull()
  })

  it('contributes nothing to a slot it did not name', () => {
    const extensions = registerUiModules([gmailModule])

    expect(extensions.navItems('admin')).toEqual([])
    expect(extensions.recordTabs('company')).toEqual([])
  })
})

describe('ordering', () => {
  it('places contributions by order, and unordered ones last', () => {
    const ordered = inSlotOrder([
      { id: 'late', order: 900 },
      { id: 'unordered' },
      { id: 'early', order: 100 },
    ])

    expect(ordered.map((item) => item.id)).toEqual(['early', 'late', 'unordered'])
  })

  it('keeps registration order among equals rather than shuffling between builds', () => {
    const ordered = inSlotOrder([{ id: 'first', order: 100 }, { id: 'second', order: 100 }])

    expect(ordered.map((item) => item.id)).toEqual(['first', 'second'])
  })

  it('sorts a slot across two modules', () => {
    const first: UiModule = {
      id: 'first',
      register: (context) => {
        context.nav('primary', { id: 'later', label: 'Later', to: '/later', order: 400 })
      },
    }
    const second: UiModule = {
      id: 'second',
      register: (context) => {
        context.nav('primary', { id: 'sooner', label: 'Sooner', to: '/sooner', order: 200 })
      },
    }

    const extensions = registerUiModules([first, second])

    expect(extensions.navItems('primary').map((item) => item.id)).toEqual(['sooner', 'later'])
  })
})

describe('a build that would break at runtime', () => {
  it('refuses two modules sharing an id', () => {
    expect(() => registerUiModules([gmailModule, gmailModule])).toThrow(UiModuleError)
  })

  it('refuses two modules claiming one contribution id', () => {
    const clashing: UiModule = {
      id: 'other',
      register: (context) => {
        context.nav('primary', { id: 'gmail', label: 'Also Gmail', to: '/elsewhere' })
      },
    }

    expect(() => registerUiModules([gmailModule, clashing])).toThrow(/already taken/u)
  })

  it('allows one id in two different slots', () => {
    const twoSlots: UiModule = {
      id: 'reports',
      register: (context) => {
        context.nav('primary', { id: 'reports', label: 'Reports', to: '/reports' })
        context.nav('admin', { id: 'reports', label: 'Reports', to: '/admin/reports' })
      },
    }

    expect(() => registerUiModules([twoSlots])).not.toThrow()
  })

  it('refuses two modules overriding one component', () => {
    const alsoOverriding: UiModule = {
      id: 'other',
      register: (context) => {
        context.override(recordHeader, () => <h2>Third header</h2>)
      },
    }

    expect(() => registerUiModules([gmailModule, alsoOverriding])).toThrow(/already replaced/u)
  })
})
