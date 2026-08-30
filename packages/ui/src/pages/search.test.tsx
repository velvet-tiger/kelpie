import { QueryClient } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it } from 'vitest'

import { ApiProvider } from '../api/ApiProvider.tsx'
import { stubClient } from '../testing/stubClient.ts'
import { SearchPage } from './SearchPage.tsx'

afterEach(cleanup)

/**
 * What this page could show that is untrue: a group the API sent as empty
 * rendered as a heading with nothing under it, a capped list presented as the
 * whole answer, and a link pointing at the wrong detail page.
 *
 * The ranking, the matching and the snippet are the server's. Nothing here
 * re-implements them, so nothing here tests them.
 */

interface WireGroup {
  readonly type: string
  readonly total: number
  readonly items: readonly Record<string, unknown>[]
}

const EMPTY_TYPES = [
  'handbook_page',
  'person',
  'role',
  'company',
  'enquiry',
  'deal',
  'opportunity',
  'raise',
  'partnership',
  'decision',
] as const

/** A full ten-group response with the named groups filled in. */
function wireResults(query: string, filled: readonly WireGroup[]): Record<string, unknown> {
  const byType = new Map(filled.map((group) => [group.type, group]))

  return {
    query,
    limit: 10,
    total: filled.reduce((sum, group) => sum + group.total, 0),
    groups: EMPTY_TYPES.map(
      (type) => byType.get(type) ?? { type, total: 0, items: [] },
    ),
  }
}

function renderPage(query: string, payload: Record<string, unknown>): void {
  render(
    <ApiProvider
      client={stubClient({ get: () => payload })}
      queryClient={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <MemoryRouter initialEntries={[`/search?q=${encodeURIComponent(query)}`]}>
        <SearchPage />
      </MemoryRouter>
    </ApiProvider>,
  )
}

describe('SearchPage', () => {
  it('prompts rather than searching when there is no query', () => {
    render(
      <ApiProvider
        client={stubClient({})}
        queryClient={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <MemoryRouter initialEntries={['/search']}>
          <SearchPage />
        </MemoryRouter>
      </ApiProvider>,
    )

    // `stubClient({})` throws on any request, so reaching the API would fail here.
    expect(screen.getByText('Search Kelpie')).toBeDefined()
  })

  it('says so when nothing matched', async () => {
    renderPage('nothing', wireResults('nothing', []))

    await waitFor(() => {
      expect(screen.getByText('No matches')).toBeDefined()
    })
  })

  it('counts results across every group', async () => {
    renderPage(
      'acme',
      wireResults('acme', [
        { type: 'person', total: 1, items: [{ id: 'per_1', title: 'Ada', subtitle: null, snippet: '' }] },
        { type: 'company', total: 1, items: [{ id: 'com_1', title: 'Acme', subtitle: null, snippet: '' }] },
      ]),
    )

    await waitFor(() => {
      expect(screen.getByText('2 results for “acme”')).toBeDefined()
    })
  })

  it('renders one result without pluralising', async () => {
    renderPage(
      'acme',
      wireResults('acme', [
        { type: 'company', total: 1, items: [{ id: 'com_1', title: 'Acme', subtitle: null, snippet: '' }] },
      ]),
    )

    await waitFor(() => {
      expect(screen.getByText('1 result for “acme”')).toBeDefined()
    })
  })

  it('leaves out a group the API answered as empty', async () => {
    renderPage(
      'acme',
      wireResults('acme', [
        { type: 'company', total: 1, items: [{ id: 'com_1', title: 'Acme', subtitle: null, snippet: '' }] },
      ]),
    )

    await waitFor(() => {
      expect(screen.getByText('Companies')).toBeDefined()
    })

    expect(screen.queryByText('Deals')).toBeNull()
    expect(screen.queryByText('Handbook')).toBeNull()
  })

  it('says a list is capped rather than presenting it as the whole answer', async () => {
    renderPage(
      'acme',
      wireResults('acme', [
        {
          type: 'company',
          total: 42,
          items: [{ id: 'com_1', title: 'Acme', subtitle: null, snippet: '' }],
        },
      ]),
    )

    await waitFor(() => {
      expect(screen.getByText('showing 1 of 42')).toBeDefined()
    })
  })

  it('links each collection at its own detail page', async () => {
    renderPage(
      'acme',
      wireResults('acme', [
        { type: 'person', total: 1, items: [{ id: 'per_1', title: 'Ada', subtitle: null, snippet: '' }] },
        { type: 'raise', total: 1, items: [{ id: 'rse_1', title: 'Seed', subtitle: null, snippet: '' }] },
        {
          type: 'handbook_page',
          total: 1,
          items: [{ id: 'hb_1', title: 'How we sell', subtitle: null, snippet: '' }],
        },
      ]),
    )

    await waitFor(() => {
      expect(screen.getByText('Ada').closest('a')?.getAttribute('href')).toBe('/people/per_1')
    })

    // Fundraising, not `/raises`: the route is named for the sidebar entry.
    expect(screen.getByText('Seed').closest('a')?.getAttribute('href')).toBe('/fundraising/rse_1')
    expect(screen.getByText('How we sell').closest('a')?.getAttribute('href')).toBe('/handbook/hb_1')
  })

  it('sends a decision to the global list, which is where one is read', async () => {
    renderPage(
      'promise',
      wireResults('promise', [
        {
          type: 'decision',
          total: 1,
          items: [{ id: 'dec_1', title: 'We promised a review', subtitle: '2026-08-02', snippet: '' }],
        },
      ]),
    )

    await waitFor(() => {
      expect(screen.getByText('We promised a review').closest('a')?.getAttribute('href')).toBe(
        '/decisions',
      )
    })
  })

  it('shows the subtitle and the snippet when the record has them', async () => {
    renderPage(
      'engine',
      wireResults('engine', [
        {
          type: 'person',
          total: 1,
          items: [
            {
              id: 'per_1',
              title: 'Ada Lovelace',
              subtitle: 'ada@analytical.test',
              snippet: '…runs the engine programme…',
            },
          ],
        },
      ]),
    )

    await waitFor(() => {
      expect(screen.getByText('ada@analytical.test')).toBeDefined()
    })

    expect(screen.getByText('…runs the engine programme…')).toBeDefined()
  })
})
