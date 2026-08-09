import type { SearchCollection, SearchResult, SearchResultGroup } from '@kelpie/schemas'
import { Link, useSearchParams } from 'react-router'

import { useSearch } from '../api/resources/search.ts'
import { ErrorPanel, LoadingPanel } from '../components/QueryState.tsx'
import { PageHeader } from '../components/PageHeader.tsx'

/**
 * `/search?q=`, the destination of the box in the application shell.
 *
 * The server decides what matched, how it ranks, and what each row says. The
 * mockup did all three in the browser over seed data; here the page is a
 * renderer, and the only thing it still owns is where a result links to.
 */

/** What each collection is called on screen, and where one of its results lives. */
const COLLECTIONS: Readonly<Record<SearchCollection, { label: string; path: (id: string) => string }>> = {
  handbook_page: { label: 'Handbook', path: (id) => `/handbook/${id}` },
  person: { label: 'People', path: (id) => `/people/${id}` },
  role: { label: 'Roles', path: (id) => `/hiring/${id}` },
  company: { label: 'Companies', path: (id) => `/companies/${id}` },
  deal: { label: 'Deals', path: (id) => `/deals/${id}` },
  opportunity: { label: 'Opportunities', path: (id) => `/opportunities/${id}` },
  raise: { label: 'Fundraising', path: (id) => `/fundraising/${id}` },
  partnership: { label: 'Partnerships', path: (id) => `/partnerships/${id}` },
  // Decisions have no detail page of their own, in the mockup or here. The global
  // list is where one is read.
  decision: { label: 'Decisions', path: () => '/decisions' },
}

export function SearchPage(): React.JSX.Element {
  const [params] = useSearchParams()
  const term = params.get('q') ?? ''
  const { results, isLoading, error } = useSearch(term)

  if (term.trim().length === 0) {
    return (
      <div className="animate-fade-in py-16 text-center">
        <p className="text-[15px] font-medium text-ink">Search Kelpie</p>
        <p className="mt-1 text-[13px] text-ink-muted">
          Find people, companies, deals, raises, decisions, and handbook pages.
        </p>
      </div>
    )
  }

  return (
    <div className="animate-fade-in mx-auto max-w-3xl">
      <PageHeader
        title="Search"
        description={
          results === undefined
            ? `Searching for “${term}”`
            : `${String(results.total)} result${results.total === 1 ? '' : 's'} for “${term}”`
        }
      />

      {error !== null && <ErrorPanel error={error} />}
      {error === null && isLoading && <LoadingPanel label="Searching…" />}

      {results !== undefined && results.total === 0 && (
        <div className="rounded-lg border border-dashed border-border-strong bg-surface-raised px-6 py-14 text-center">
          <p className="text-[15px] font-medium text-ink">No matches</p>
          <p className="mt-1 text-[13px] text-ink-muted">
            Try a name, tag, plan item, or handbook topic.
          </p>
        </div>
      )}

      {results !== undefined && results.total > 0 && (
        <div className="space-y-6">
          {results.groups.map((group) => (
            <ResultGroup key={group.collection} group={group} />
          ))}
        </div>
      )}
    </div>
  )
}

function ResultGroup({ group }: { readonly group: SearchResultGroup }): React.JSX.Element | null {
  if (group.items.length === 0) {
    return null
  }

  const { label } = COLLECTIONS[group.collection]
  // `total` counts every match; the list is capped by the request. Saying so
  // beats a list that silently stops at ten.
  const withheld = group.total - group.items.length

  return (
    <section>
      <h2 className="mb-2 flex items-baseline gap-2 text-[11px] font-semibold tracking-wide text-ink-faint uppercase">
        {label}
        {withheld > 0 && (
          <span className="font-normal normal-case">
            showing {group.items.length} of {group.total}
          </span>
        )}
      </h2>
      <ul className="overflow-hidden rounded-md border border-border">
        {group.items.map((item) => (
          <li key={item.id} className="border-b border-border last:border-0">
            <ResultRow collection={group.collection} item={item} />
          </li>
        ))}
      </ul>
    </section>
  )
}

function ResultRow({
  collection,
  item,
}: {
  readonly collection: SearchCollection
  readonly item: SearchResult
}): React.JSX.Element {
  return (
    <Link
      to={COLLECTIONS[collection].path(item.id)}
      className="block px-4 py-2.5 transition hover:bg-accent-soft/30"
    >
      <div className="flex items-center justify-between gap-3">
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-ink">{item.title}</span>
        {item.subtitle !== null && item.subtitle.length > 0 && (
          <span className="max-w-[45%] truncate text-[11px] text-ink-faint">{item.subtitle}</span>
        )}
      </div>
      {item.snippet.length > 0 && (
        <p className="mt-0.5 truncate text-[12px] text-ink-muted">{item.snippet}</p>
      )}
    </Link>
  )
}
