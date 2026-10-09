import { API_KEY_OBJECT_DATA_RESOURCES } from '@kelpie/schemas'
import { QueryClient } from '@tanstack/react-query'
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it } from 'vitest'

import { ApiProvider } from '../../api/ApiProvider.tsx'
import { stubClient } from '../../testing/stubClient.ts'
import { ConnectedAppsPage } from './ConnectedAppsPage.tsx'

afterEach(cleanup)

/**
 * What this page can get wrong in a way a person would act on: ending every
 * workspace of a connection when they asked to disconnect one, and the reverse.
 */

function grant(
  id: string,
  connectionId: string,
  workspaceName: string,
  extraScopes: readonly string[] = [],
): Record<string, unknown> {
  return {
    id,
    connection_id: connectionId,
    client_name: 'Example Agent',
    client_host: 'client.example',
    workspace_id: `ws_${id}`,
    workspace_name: workspaceName,
    scopes: ['read:objects', ...extraScopes],
    extra_scopes: extraScopes,
    last_used_at: null,
    created_at: '2026-10-01T01:00:00.000Z',
  }
}

/** One connection for two workspaces, and one for a single workspace. */
const GRANTS = [
  grant('ogr_1', 'ocn_1', 'Acme'),
  grant('ogr_2', 'ocn_1', 'Globex'),
  grant('ogr_3', 'ocn_2', 'Initech', ['decisions:commit']),
]

function renderPage(deleted: string[]): void {
  const client = stubClient({
    get: (path) => {
      throw new Error(`Unexpected get ${path}`)
    },
    list: (path) => {
      if (path !== '/oauth/grants') {
        throw new Error(`Unexpected list ${path}`)
      }

      return { items: GRANTS, nextCursor: null }
    },
    delete: (path) => {
      deleted.push(path)
    },
  })

  render(
    <MemoryRouter>
      <ApiProvider
        client={client}
        queryClient={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}
      >
        <ConnectedAppsPage />
      </ApiProvider>
    </MemoryRouter>,
  )
}

function rowFor(workspaceName: string): HTMLElement {
  const row = screen.getByText(workspaceName).closest('tr')

  if (row === null) {
    throw new Error(`No row for ${workspaceName}`)
  }

  return row
}

describe('ConnectedAppsPage', () => {
  it('names the extra permissions of a connection apart from its access, and only where it has one', async () => {
    renderPage([])

    await screen.findByText('Acme')

    const extras = within(rowFor('Initech')).getByRole('list', { name: 'Extra permissions' })

    expect(within(extras).getByText('Decisions (commit without confirmation)')).toBeTruthy()
    // Named once: the access list beside it does not repeat it.
    expect(within(rowFor('Initech')).getAllByText(/commit without confirmation/u)).toHaveLength(1)
    expect(within(rowFor('Initech')).getByText('Read objects')).toBeTruthy()
    expect(within(rowFor('Acme')).queryByRole('list', { name: 'Extra permissions' })).toBeNull()
  })

  it('marks a connection that holds one delete scope, or a preset that holds a sensitive scope', async () => {
    const client = stubClient({
      list: () => ({
        items: [
          grant('ogr_4', 'ocn_4', 'Hooli', ['people:delete']),
          // The server names the power: `write:all` holds the handbook write.
          { ...grant('ogr_5', 'ocn_5', 'Umbrella'), scopes: ['read:all', 'write:all'], extra_scopes: ['handbook:write'] },
        ],
        nextCursor: null,
      }),
    })

    render(
      <MemoryRouter>
        <ApiProvider
          client={client}
          queryClient={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}
        >
          <ConnectedAppsPage />
        </ApiProvider>
      </MemoryRouter>,
    )

    await screen.findByText('Hooli')

    expect(within(rowFor('Hooli')).getByRole('list', { name: 'Extra permissions' }).textContent).toBe('People (delete)')
    expect(within(rowFor('Umbrella')).getByRole('list', { name: 'Extra permissions' }).textContent).toBe(
      'Handbook (write)',
    )
    // The preset stays in the access list; the chip says what it holds.
    expect(within(rowFor('Umbrella')).getByText('Read all, Write all')).toBeTruthy()
  })

  it('shows one chip, and no list of names, for a connection that holds every delete scope by name', async () => {
    const deletes = API_KEY_OBJECT_DATA_RESOURCES.map((resource) => `${resource}:delete`)
    const client = stubClient({
      list: () => ({
        items: [
          {
            ...grant('ogr_6', 'ocn_6', 'Soylent'),
            scopes: ['read:objects', ...deletes],
            extra_scopes: ['delete:objects'],
          },
        ],
        nextCursor: null,
      }),
    })

    render(
      <MemoryRouter>
        <ApiProvider
          client={client}
          queryClient={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}
        >
          <ConnectedAppsPage />
        </ApiProvider>
      </MemoryRouter>,
    )

    await screen.findByText('Soylent')

    expect(within(rowFor('Soylent')).getByRole('list', { name: 'Extra permissions' }).textContent).toBe('Delete objects')
    expect(within(rowFor('Soylent')).queryByText(/\(delete\)/u)).toBeNull()
    expect(within(rowFor('Soylent')).getByText('Read objects')).toBeTruthy()
  })

  it('offers Disconnect all only on a connection with more than one workspace', async () => {
    renderPage([])

    await screen.findByText('Acme')

    expect(screen.getAllByRole('button', { name: 'Disconnect all' })).toHaveLength(1)
    expect(within(rowFor('Acme')).getByRole('button', { name: 'Disconnect all' })).toBeTruthy()
    expect(screen.getAllByRole('button', { name: 'Disconnect' })).toHaveLength(3)
  })

  it('disconnects one workspace and leaves the connection', async () => {
    const deleted: string[] = []

    renderPage(deleted)
    await screen.findByText('Globex')

    await act(async () => {
      within(rowFor('Globex')).getByRole('button', { name: 'Disconnect' }).click()
    })
    await act(async () => {
      within(rowFor('Globex')).getByRole('button', { name: 'Disconnect' }).click()
    })

    await waitFor(() => {
      expect(deleted).toEqual(['/oauth/grants/ogr_2'])
    })
  })

  it('disconnects every workspace of the connection after a confirmation', async () => {
    const deleted: string[] = []

    renderPage(deleted)
    await screen.findByText('Acme')

    await act(async () => {
      screen.getByRole('button', { name: 'Disconnect all' }).click()
    })

    expect(deleted).toEqual([])

    await act(async () => {
      screen.getByRole('button', { name: 'Disconnect all 2 workspaces' }).click()
    })

    await waitFor(() => {
      expect(deleted).toEqual(['/oauth/connections/ocn_1'])
    })
  })
})
