import { QueryClient } from '@tanstack/react-query'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { stubClient } from '../testing/stubClient.ts'
import type { ClientStubs, WirePage } from '../testing/stubClient.ts'
import { ApiProvider } from './ApiProvider.tsx'
import { ApiError } from './client.ts'
import type { ApiClient } from './client.ts'
import { createResourceHooks } from './resource.ts'

afterEach(cleanup)

/**
 * The optimistic paths, which are the ones that can lose a user's edit.
 *
 * These use a stand-in resource rather than People so the assertions are about
 * the cache machinery and not about a person's field list.
 */

interface Widget {
  readonly id: string
  readonly name: string
}

interface WidgetInput {
  readonly name?: string
}

const widgets = createResourceHooks<Widget, WidgetInput, WidgetInput>({
  name: 'widgets',
  path: '/widgets',
  decode: (value: unknown) => value as Widget,
  createBody: (input) => input,
  updateBody: (input) => input,
})

/** A promise plus the handles to settle it, so a test can assert mid-flight state. */
function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: unknown) => void
} {
  let resolve: (value: T) => void = () => undefined
  let reject: (error: unknown) => void = () => undefined
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })

  return { promise, resolve, reject }
}

function page(items: readonly Widget[], nextCursor: string | null = null): WirePage {
  return { items, nextCursor }
}

function renderWithClient(client: ApiClient, element: React.JSX.Element): void {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })

  render(
    <ApiProvider client={client} queryClient={queryClient}>
      {element}
    </ApiProvider>,
  )
}

function WidgetDetail({ id }: { readonly id: string }): React.JSX.Element {
  const { record, isLoading, isNotFound } = widgets.useRecord(id)
  const update = widgets.useUpdate()

  if (isNotFound) {
    return <p>not found</p>
  }

  if (isLoading || record === undefined) {
    return <p>loading</p>
  }

  return (
    <div>
      <p data-testid="name">{record.name}</p>
      <button type="button" onClick={() => update.run({ id, changes: { name: 'Renamed' } })}>
        rename
      </button>
    </div>
  )
}

function WidgetList(): React.JSX.Element {
  const { records, isLoading, hasNext, hasPrev, nextPage, prevPage } = widgets.useList()
  const remove = widgets.useRemove()

  if (isLoading) {
    return <p>loading</p>
  }

  return (
    <div>
      <ul>
        {records.map((widget) => (
          <li key={widget.id}>
            <span>{widget.name}</span>
            <button type="button" onClick={() => remove.run(widget.id)}>
              delete {widget.name}
            </button>
          </li>
        ))}
      </ul>
      <button type="button" onClick={prevPage} disabled={!hasPrev}>
        prev
      </button>
      <button type="button" onClick={nextPage} disabled={!hasNext}>
        next
      </button>
    </div>
  )
}

describe('createResourceHooks', () => {
  it('shows an update before the server confirms it, then takes what the server returns', async () => {
    const patched = deferred<Widget>()
    // The refetch that follows a successful write has to see the write, or the
    // assertion below would be about a stub rather than about the cache.
    let stored: Widget = { id: 'w_1', name: 'Original' }
    const client = stubClient({
      get: () => Promise.resolve(stored),
      patch: () => patched.promise,
    })

    renderWithClient(client, <WidgetDetail id="w_1" />)
    await screen.findByText('Original')

    await act(async () => {
      screen.getByRole('button', { name: 'rename' }).click()
    })

    // The request is still in flight: this value can only have come from onMutate.
    await waitFor(() => {
      expect(screen.getByTestId('name').textContent).toBe('Renamed')
    })

    // A server that normalises the value wins over the guess.
    await act(async () => {
      stored = { id: 'w_1', name: 'Renamed by the server' }
      patched.resolve(stored)
    })

    await waitFor(() => {
      expect(screen.getByTestId('name').textContent).toBe('Renamed by the server')
    })
  })

  it('puts the old value back when the update fails', async () => {
    const patched = deferred<Widget>()
    const client = stubClient({
      get: () => Promise.resolve({ id: 'w_1', name: 'Original' }),
      patch: () => patched.promise,
    })

    renderWithClient(client, <WidgetDetail id="w_1" />)
    await screen.findByText('Original')

    await act(async () => {
      screen.getByRole('button', { name: 'rename' }).click()
    })

    await waitFor(() => {
      expect(screen.getByTestId('name').textContent).toBe('Renamed')
    })

    await act(async () => {
      patched.reject(new ApiError(422, 'validation_failed', 'Name is invalid'))
    })

    await waitFor(() => {
      expect(screen.getByTestId('name').textContent).toBe('Original')
    })
  })

  it('reports a 404 as not found rather than as an error', async () => {
    const client = stubClient({
      get: () => Promise.reject(new ApiError(404, 'not_found', 'No such widget')),
    })

    renderWithClient(client, <WidgetDetail id="w_missing" />)

    expect(await screen.findByText('not found')).toBeTruthy()
  })

  it('removes a row before the server confirms, and restores it on failure', async () => {
    const deletion = deferred<void>()
    const client = stubClient({
      list: () => Promise.resolve(page([{ id: 'w_1', name: 'First' }, { id: 'w_2', name: 'Second' }])),
      delete: () => deletion.promise,
    })

    renderWithClient(client, <WidgetList />)
    await screen.findByText('First')

    await act(async () => {
      screen.getByRole('button', { name: 'delete First' }).click()
    })

    await waitFor(() => {
      expect(screen.queryByText('First')).toBeNull()
    })

    await act(async () => {
      deletion.reject(new ApiError(409, 'delete_blocked', 'Still referenced'))
    })

    await waitFor(() => {
      expect(screen.getByText('First')).toBeTruthy()
    })
  })

  it('invalidates a related resource when a join record is created', async () => {
    // The bug this covers: a Position is created, the company page refetches
    // positions, and renders the new row against a people list it never
    // refetched — so the person's name reads "Unknown".
    const linked = createResourceHooks<Widget, WidgetInput, WidgetInput>({
      name: 'links',
      path: '/links',
      decode: (value: unknown) => value as Widget,
      createBody: (input) => input,
      updateBody: (input) => input,
      alsoInvalidates: ['widgets'],
    })

    const widgetList = vi
      .fn<NonNullable<ClientStubs['list']>>()
      .mockResolvedValueOnce(page([]))
      .mockResolvedValue(page([{ id: 'w_1', name: 'First' }]))

    function CreatesALink(): React.JSX.Element {
      const { records } = widgets.useList()
      const create = linked.useCreate()

      return (
        <div>
          <p data-testid="names">{records.map((widget) => widget.name).join(',')}</p>
          <button type="button" onClick={() => create.run({ name: 'link' })}>
            link
          </button>
        </div>
      )
    }

    renderWithClient(
      stubClient({
        list: widgetList,
        post: () => Promise.resolve({ id: 'l_1', name: 'link' }),
      }),
      <CreatesALink />,
    )

    await waitFor(() => {
      expect(screen.getByTestId('names').textContent).toBe('')
    })

    await act(async () => {
      screen.getByRole('button', { name: 'link' }).click()
    })

    await waitFor(() => {
      expect(screen.getByTestId('names').textContent).toBe('First')
    })
  })

  it('shows one page at a time and pages forward and back', async () => {
    const list = vi
      .fn<NonNullable<ClientStubs['list']>>()
      .mockResolvedValueOnce(page([{ id: 'w_1', name: 'First' }], 'cursor_2'))
      .mockResolvedValueOnce(page([{ id: 'w_2', name: 'Second' }]))

    renderWithClient(stubClient({ list }), <WidgetList />)
    await screen.findByText('First')
    expect(screen.queryByText('Second')).toBeNull()

    await act(async () => {
      screen.getByRole('button', { name: 'next' }).click()
    })

    await waitFor(() => {
      expect(screen.getByText('Second')).toBeTruthy()
    })
    // The first page rolled off screen. Pagination replaces, it does not append.
    expect(screen.queryByText('First')).toBeNull()

    // Server said this was the last page.
    expect((screen.getByRole('button', { name: 'next' }) as HTMLButtonElement).disabled).toBe(true)

    // Going back reads the cached first page rather than firing a fresh request.
    await act(async () => {
      screen.getByRole('button', { name: 'prev' }).click()
    })

    await waitFor(() => {
      expect(screen.getByText('First')).toBeTruthy()
    })
    expect(list).toHaveBeenCalledTimes(2)
    expect(list).toHaveBeenNthCalledWith(1, '/widgets', { limit: 50 })
    expect(list).toHaveBeenNthCalledWith(2, '/widgets', { limit: 50, cursor: 'cursor_2' })
  })
})
