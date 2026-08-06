import { QueryClient } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { ApiProvider } from '../api/ApiProvider.tsx'
import type { ApiClient, QueryParameters } from '../api/client.ts'
import { useCandidateNotes } from './hiringDirectory.ts'

afterEach(cleanup)

/**
 * The candidate note lookup, which is what stops a role's pipeline making one
 * request per row.
 *
 * What could go wrong is not the request count on its own: it is showing the
 * wrong candidate's note, or offering an empty editor for a candidate whose
 * note was simply not on the page that came back.
 */

function note(id: string, targetId: string, body: string, createdAt: string): unknown {
  return {
    id,
    target_type: 'candidate',
    target_id: targetId,
    body,
    author_id: 'mem_1',
    pinned: false,
    created_at: createdAt,
    updated_at: createdAt,
  }
}

interface ListCall {
  readonly path: string
  readonly query: QueryParameters | undefined
}

function stubClient(
  notes: readonly unknown[],
  calls: ListCall[],
  nextCursor: string | null = null,
): ApiClient {
  const unexpected = (name: string) => (): never => {
    throw new Error(`Unexpected ${name} call`)
  }

  return {
    get: unexpected('get'),
    list: (path, decodeItem, query) => {
      calls.push({ path, query })

      return Promise.resolve({ items: notes.map(decodeItem), nextCursor })
    },
    getText: unexpected('getText'),
    post: unexpected('post'),
    postForm: unexpected('postForm'),
    postEmpty: unexpected('postEmpty'),
    patchEmpty: unexpected('patchEmpty'),
    patch: unexpected('patch'),
    delete: unexpected('delete'),
  }
}

function Probe({ candidateIds }: { readonly candidateIds: readonly string[] }): React.JSX.Element {
  const notes = useCandidateNotes(candidateIds)

  if (notes.isLoading) {
    return <p>loading</p>
  }

  return (
    <ul data-testid="rows">
      {candidateIds.map((id) => (
        <li key={id} data-testid={id}>
          {notes.noteFor(id)?.body ?? (notes.isComplete ? 'none' : 'unknown')}
        </li>
      ))}
    </ul>
  )
}

function renderProbe(client: ApiClient, candidateIds: readonly string[]): void {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })

  render(
    <ApiProvider client={client} queryClient={queryClient}>
      <Probe candidateIds={candidateIds} />
    </ApiProvider>,
  )
}

describe('useCandidateNotes', () => {
  it('asks about every candidate in one request, naming them all on the filter', async () => {
    const calls: ListCall[] = []
    const client = stubClient(
      [
        note('note_1', 'can_1', 'Strong on systems', '2026-02-02T00:00:00.000Z'),
        note('note_2', 'can_2', 'Rescheduling', '2026-02-01T00:00:00.000Z'),
      ],
      calls,
    )

    renderProbe(client, ['can_1', 'can_2', 'can_3'])

    await waitFor(() => {
      expect(screen.getByTestId('can_1').textContent).toBe('Strong on systems')
    })

    expect(calls).toHaveLength(1)
    expect(calls[0]?.path).toBe('/notes')
    expect(calls[0]?.query).toMatchObject({
      target_type: 'candidate',
      target_id: ['can_1', 'can_2', 'can_3'],
    })
  })

  it('gives each candidate their own newest note', async () => {
    const calls: ListCall[] = []
    const client = stubClient(
      [
        // Newest first, the way `-created_at` returns them.
        note('note_3', 'can_1', 'Newest for one', '2026-02-03T00:00:00.000Z'),
        note('note_2', 'can_2', 'Only for two', '2026-02-02T00:00:00.000Z'),
        note('note_1', 'can_1', 'Older for one', '2026-02-01T00:00:00.000Z'),
      ],
      calls,
    )

    renderProbe(client, ['can_1', 'can_2', 'can_3'])

    await waitFor(() => {
      expect(screen.getByTestId('can_1').textContent).toBe('Newest for one')
    })

    expect(screen.getByTestId('can_2').textContent).toBe('Only for two')
    // A candidate with no note is empty, not missing: the answer was complete.
    expect(screen.getByTestId('can_3').textContent).toBe('none')
  })

  it('reports the lookup incomplete when a page was left behind', async () => {
    const calls: ListCall[] = []
    const client = stubClient(
      [note('note_1', 'can_1', 'Strong on systems', '2026-02-02T00:00:00.000Z')],
      calls,
      'cursor_2',
    )

    renderProbe(client, ['can_1', 'can_2'])

    await waitFor(() => {
      expect(screen.getByTestId('can_1').textContent).toBe('Strong on systems')
    })

    // Not "none". Nothing looked for can_2's note, and a blank that means "we
    // did not look" reads the same as one that means "there is nothing".
    expect(screen.getByTestId('can_2').textContent).toBe('unknown')
  })

  it('asks nothing until there are candidates to ask about', () => {
    const calls: ListCall[] = []

    renderProbe(stubClient([], calls), [])

    expect(calls).toHaveLength(0)
  })
})
