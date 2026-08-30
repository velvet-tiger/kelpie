import {
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'
import type { InfiniteData, QueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'

import { ApiError } from './client.ts'
import type { Decoder, Page, QueryParameters } from './client.ts'
import { useApiClient } from './context.ts'
import { toError } from './errors.ts'

/**
 * The read and write hooks for one `/v1` collection.
 *
 * Every CRM resource is the same five operations over the same list envelope,
 * so they are built once here and configured per resource. A resource module
 * supplies its path, its decoder, and its two body builders; it writes no cache
 * handling of its own.
 *
 * Pages see the three result types below and never import from
 * `@tanstack/react-query` directly. That is deliberate: it keeps page code short
 * and leaves the cache library replaceable without touching a page.
 */

/**
 * The default page size when a caller does not name one via `query.limit`.
 * Matches the `/v1` default from `api.md`.
 */
export const DEFAULT_PAGE_SIZE = 50

/**
 * The pagination controls a list surface renders. Split out from
 * `RecordListResult` so the `Paginator` component can accept just this subset
 * and stay generic in the record type.
 */
export interface Paged {
  /** Zero-based index of the page currently on screen. */
  readonly pageIndex: number
  /** Number of records the API returns per page, from `?limit=`. */
  readonly pageSize: number
  readonly hasPrev: boolean
  readonly hasNext: boolean
  /** True while fetching a not-yet-cached page. Prev on a cached page is instant. */
  readonly isChangingPage: boolean
  readonly prevPage: () => void
  readonly nextPage: () => void
  /**
   * Changes the API `?limit=` and returns the reader to page 1. The API caps
   * `?limit=` at 200 (`api.md`); a larger value is coerced by the server, not
   * refused by this hook.
   */
  readonly setPageSize: (size: number) => void
}

/**
 * A list, one page at a time. Records are the current page only, not the
 * accumulation across pages a `Load more` reader would give.
 */
export interface RecordListResult<TRecord> extends Paged {
  readonly records: readonly TRecord[]
  readonly isLoading: boolean
  readonly error: Error | null
}

export interface RecordResult<TRecord> {
  readonly record: TRecord | undefined
  readonly isLoading: boolean
  readonly error: Error | null
  /** The record is not in this workspace, which `api.md` makes indistinguishable from not existing. */
  readonly isNotFound: boolean
}

export interface MutationResult<TInput, TOutput> {
  /** Fire and forget. A failure lands in `error` rather than in an unhandled rejection. */
  readonly run: (input: TInput) => void
  /** Await the result, for a caller that navigates or chains on success. Rejects on failure. */
  readonly runAsync: (input: TInput) => Promise<TOutput>
  readonly isPending: boolean
  readonly error: Error | null
}

export interface UpdateArguments<TUpdateInput> {
  readonly id: string
  readonly changes: TUpdateInput
}

export interface PatchResult<TChanges> {
  /** Fire and forget, bound to one record's id. A failure lands in `error`. */
  readonly patch: (changes: TChanges) => void
  readonly error: Error | null
}

export interface ListOptions {
  /**
   * Set false to hold the request back. A list filtered by a set of ids has
   * nothing to ask until those ids are known, and asking with the filter omitted
   * would answer with every record instead of none.
   */
  readonly enabled?: boolean
}

export interface ResourceHooks<TRecord, TCreateInput, TUpdateInput>
  extends ReadOnlyResourceHooks<TRecord> {
  useCreate(): MutationResult<TCreateInput, TRecord>
  useUpdate(): MutationResult<UpdateArguments<TUpdateInput>, TRecord>
  useRemove(): MutationResult<string, void>
}

/** What a collection with no write verbs offers. Activities are the case: the table is append-only. */
export interface ReadOnlyResourceHooks<TRecord> {
  useList(query?: QueryParameters, options?: ListOptions): RecordListResult<TRecord>
  useRecord(id: string | undefined): RecordResult<TRecord>
}

export interface ReadOnlyResourceDefinition<TRecord> {
  /** Cache key root. The plural resource name, e.g. `activities`. */
  readonly name: string
  /** Path under the API base, e.g. `/activities`. */
  readonly path: string
  readonly decode: Decoder<TRecord>
}

export interface ResourceDefinition<TRecord, TCreateInput, TUpdateInput>
  extends ReadOnlyResourceDefinition<TRecord> {
  readonly createBody: (input: TCreateInput) => unknown
  readonly updateBody: (input: TUpdateInput) => unknown
  /**
   * Other resources whose cached lists a write here can invalidate.
   *
   * A join record is the case that needs it. `GET /v1/people?company_id=` is a
   * list of people, so creating a Position changes its contents without
   * touching a single person, and a company page that only refetched positions
   * would render the new row against a name it never fetched.
   */
  readonly alsoInvalidates?: readonly string[]
}

type ListData<TRecord> = InfiniteData<Page<TRecord>, string | null>

interface ResourceKeys {
  readonly all: readonly unknown[]
  readonly lists: readonly unknown[]
  list(query: QueryParameters): readonly unknown[]
  detail(id: string): readonly unknown[]
}

function keysFor(name: string): ResourceKeys {
  return {
    all: [name],
    lists: [name, 'list'],
    list: (query) => [name, 'list', query],
    detail: (id) => [name, 'detail', id],
  }
}

/**
 * Applies a partial update to a record.
 *
 * `undefined` means "not sent" and `null` means "clear this field", per
 * `api.md`, so an undefined value must leave the existing one alone rather than
 * overwrite it.
 */
function mergeDefined<TRecord extends object>(record: TRecord, changes: Partial<TRecord>): TRecord {
  const merged = { ...record }

  for (const [key, value] of Object.entries(changes)) {
    if (value !== undefined) {
      Object.assign(merged, { [key]: value })
    }
  }

  return merged
}

/** Rewrites one record everywhere it is cached: its own entry, and every list page holding it. */
function writeRecordEverywhere<TRecord extends { readonly id: string }>(
  queryClient: QueryClient,
  keys: ResourceKeys,
  record: TRecord,
): void {
  queryClient.setQueryData(keys.detail(record.id), record)
  queryClient.setQueriesData<ListData<TRecord>>({ queryKey: keys.lists }, (data) =>
    data === undefined
      ? data
      : {
          ...data,
          pages: data.pages.map((page) => ({
            ...page,
            items: page.items.map((item) => (item.id === record.id ? record : item)),
          })),
        },
  )
}

function removeRecordEverywhere<TRecord extends { readonly id: string }>(
  queryClient: QueryClient,
  keys: ResourceKeys,
  id: string,
): void {
  queryClient.removeQueries({ queryKey: keys.detail(id) })
  queryClient.setQueriesData<ListData<TRecord>>({ queryKey: keys.lists }, (data) =>
    data === undefined
      ? data
      : {
          ...data,
          pages: data.pages.map((page) => ({
            ...page,
            items: page.items.filter((item) => item.id !== id),
          })),
        },
  )
}

export interface PagedListInput<TRecord> {
  /**
   * The React Query cache key for this list, without `?limit=`. `usePagedList`
   * appends the current page size so the cache splits by size — swapping page
   * sizes has to fetch, or the cursors from one size would page a list saved
   * under another.
   */
  readonly queryKey: readonly unknown[]
  readonly path: string
  readonly decode: Decoder<TRecord>
  /** Query parameters other than `limit` and `cursor`. `usePagedList` sends both itself. */
  readonly query: QueryParameters
  readonly enabled?: boolean
}

/**
 * The paged reader every list hook uses: `createResourceHooks`'s `useList`,
 * and the three custom collections whose paths carry a parent id
 * (`useFormSubmissions`, `useListMembers`, `useWebhookDeliveries`).
 *
 * The API is cursor-only (`api.md`), so pages are fetched forward. Already
 * fetched pages stay cached in `useInfiniteQuery`, and `pageIndex` selects
 * which one is on screen — so going back to a visited page is instant and
 * going forward past the fetched set kicks off exactly one new request.
 */
export function usePagedList<TRecord>(input: PagedListInput<TRecord>): RecordListResult<TRecord> {
  const client = useApiClient()
  const enabled = input.enabled ?? true
  const requestedLimit = input.query.limit
  const initialPageSize =
    typeof requestedLimit === 'number' && Number.isFinite(requestedLimit) && requestedLimit > 0
      ? requestedLimit
      : DEFAULT_PAGE_SIZE
  const [pageSize, setPageSize] = useState<number>(initialPageSize)
  const [pageIndex, setPageIndex] = useState<number>(0)

  const queryKey = [...input.queryKey, { limit: pageSize }] as const
  const queryKeySignature = JSON.stringify(queryKey)

  // A filter or sort change lands as a fresh `useInfiniteQuery`, so the page
  // number the user was on no longer makes sense. Effect over signature keeps
  // this cheap: same key, no re-render.
  useEffect(() => {
    setPageIndex(0)
  }, [queryKeySignature])

  const result = useInfiniteQuery({
    queryKey,
    queryFn: ({ pageParam }) =>
      client.list(input.path, input.decode, {
        ...input.query,
        limit: pageSize,
        ...(pageParam === null ? {} : { cursor: pageParam }),
      }),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    // Without this a keystroke in the filter box blanks the table while the
    // next query runs, which reads as "no results" for as long as it takes.
    placeholderData: keepPreviousData,
    enabled,
  })

  const pages = result.data?.pages ?? []
  // A shrinking cache — a delete followed by a refetch — can leave the index
  // past the last page. Clamp so a stale index never renders a blank table.
  const safeIndex = pages.length === 0 ? 0 : Math.min(pageIndex, pages.length - 1)
  const currentPage = pages[safeIndex]
  const hasCachedNext = safeIndex + 1 < pages.length
  const hasNext = hasCachedNext || result.hasNextPage
  const hasPrev = safeIndex > 0

  return {
    records: currentPage?.items ?? [],
    // A disabled query stays pending forever, which is not the same as loading.
    isLoading: result.isPending && enabled,
    error: toError(result.error),
    pageIndex: safeIndex,
    pageSize,
    hasPrev,
    hasNext,
    isChangingPage: result.isFetchingNextPage,
    prevPage: () => {
      setPageIndex((current) => Math.max(0, current - 1))
    },
    nextPage: () => {
      if (hasCachedNext) {
        setPageIndex((current) => current + 1)
        return
      }

      if (!result.hasNextPage) {
        return
      }

      void result.fetchNextPage().then((r) => {
        if (r.error === null) {
          setPageIndex((current) => current + 1)
        }
      })
    },
    // Query key includes `limit`, so the effect above resets `pageIndex` to 0
    // once React sees the new key.
    setPageSize: (size) => {
      setPageSize(size)
    },
  }
}

/**
 * The read half: `useList` and `useRecord`, and nothing that writes.
 *
 * Split out because a collection can be read-only. `createResourceHooks` builds
 * on this rather than repeating it, so both kinds of resource page, cache, and
 * report a 404 identically.
 */
export function createReadOnlyResourceHooks<TRecord>(
  definition: ReadOnlyResourceDefinition<TRecord>,
): ReadOnlyResourceHooks<TRecord> {
  const keys = keysFor(definition.name)

  function useList(query: QueryParameters = {}, options: ListOptions = {}): RecordListResult<TRecord> {
    return usePagedList<TRecord>({
      queryKey: keys.list(query),
      path: definition.path,
      decode: definition.decode,
      query,
      enabled: options.enabled ?? true,
    })
  }

  function useRecord(id: string | undefined): RecordResult<TRecord> {
    const client = useApiClient()
    const result = useQuery({
      queryKey: keys.detail(id ?? ''),
      queryFn: () => client.get(`${definition.path}/${id ?? ''}`, definition.decode),
      enabled: id !== undefined,
    })

    return {
      record: result.data,
      isLoading: result.isPending && id !== undefined,
      error: toError(result.error),
      isNotFound: result.error instanceof ApiError && result.error.status === 404,
    }
  }

  return { useList, useRecord }
}

export function createResourceHooks<
  TRecord extends { readonly id: string },
  TCreateInput,
  // The constraint is deliberately looser than `Partial<TRecord>`. A merge-patch
  // field (a record whose value type includes `null` to clear a key) does not
  // fit `Partial<TRecord>` when the record's own value type is non-null, and
  // that shape reaches the record for real (custom-fields, and any later
  // module that carries one). `mergeDefined` needs no more than an object here.
  TUpdateInput extends object,
>(
  definition: ResourceDefinition<TRecord, TCreateInput, TUpdateInput>,
): ResourceHooks<TRecord, TCreateInput, TUpdateInput> {
  const keys = keysFor(definition.name)
  const related = (definition.alsoInvalidates ?? []).map(keysFor)
  const { useList, useRecord } = createReadOnlyResourceHooks(definition)

  /**
   * Marks this resource's lists stale, and the related resources' with them.
   * Applied to every write rather than only to create and delete: a resource
   * that declares a relation has one, whichever verb reaches it.
   */
  function invalidateLists(queryClient: QueryClient): void {
    for (const target of [keys, ...related]) {
      void queryClient.invalidateQueries({ queryKey: target.lists })
    }
  }

  function useCreate(): MutationResult<TCreateInput, TRecord> {
    const client = useApiClient()
    const queryClient = useQueryClient()
    const mutation = useMutation({
      mutationFn: (input: TCreateInput) =>
        client.post(definition.path, definition.createBody(input), definition.decode),
      // No optimistic insert: the id comes from the server, and the caller
      // usually navigates straight to the new record. A placeholder id would be
      // a route to a record that does not exist yet.
      onSuccess: (record) => {
        queryClient.setQueryData(keys.detail(record.id), record)
      },
      onSettled: () => {
        invalidateLists(queryClient)
      },
    })

    return {
      run: (input) => {
        mutation.mutate(input)
      },
      runAsync: (input) => mutation.mutateAsync(input),
      isPending: mutation.isPending,
      error: toError(mutation.error),
    }
  }

  function useUpdate(): MutationResult<UpdateArguments<TUpdateInput>, TRecord> {
    const client = useApiClient()
    const queryClient = useQueryClient()
    const mutation = useMutation({
      mutationFn: ({ id, changes }: UpdateArguments<TUpdateInput>) =>
        client.patch(`${definition.path}/${id}`, definition.updateBody(changes), definition.decode),

      // Inline editing is the whole interaction on a detail page, so the field
      // has to settle the moment it is committed. The snapshot is what makes
      // that safe: a rejected PATCH puts the old value back.
      onMutate: async ({ id, changes }) => {
        await queryClient.cancelQueries({ queryKey: keys.detail(id) })
        const previous = queryClient.getQueryData<TRecord>(keys.detail(id))

        if (previous !== undefined) {
          writeRecordEverywhere(queryClient, keys, mergeDefined(previous, changes))
        }

        return { previous }
      },

      onError: (_error, _arguments_, context) => {
        if (context?.previous !== undefined) {
          writeRecordEverywhere(queryClient, keys, context.previous)
        }
      },

      onSuccess: (record) => {
        writeRecordEverywhere(queryClient, keys, record)
      },

      onSettled: (_record, _error, { id }) => {
        void queryClient.invalidateQueries({ queryKey: keys.detail(id) })
        invalidateLists(queryClient)
      },
    })

    return {
      run: (input) => {
        mutation.mutate(input)
      },
      runAsync: (input) => mutation.mutateAsync(input),
      isPending: mutation.isPending,
      error: toError(mutation.error),
    }
  }

  function useRemove(): MutationResult<string, void> {
    const client = useApiClient()
    const queryClient = useQueryClient()
    const mutation = useMutation({
      mutationFn: (id: string) => client.delete(`${definition.path}/${id}`),

      onMutate: async (id) => {
        await queryClient.cancelQueries({ queryKey: keys.all })
        const previous = queryClient.getQueryData<TRecord>(keys.detail(id))
        const previousLists = queryClient.getQueriesData<ListData<TRecord>>({ queryKey: keys.lists })

        removeRecordEverywhere<TRecord>(queryClient, keys, id)

        return { previous, previousLists }
      },

      onError: (_error, id, context) => {
        for (const [key, data] of context?.previousLists ?? []) {
          queryClient.setQueryData(key, data)
        }

        if (context?.previous !== undefined) {
          queryClient.setQueryData(keys.detail(id), context.previous)
        }
      },

      onSettled: () => {
        invalidateLists(queryClient)
      },
    })

    return {
      run: (id) => {
        mutation.mutate(id)
      },
      runAsync: (id) => mutation.mutateAsync(id),
      isPending: mutation.isPending,
      error: toError(mutation.error),
    }
  }

  return { useList, useRecord, useCreate, useUpdate, useRemove }
}

/**
 * Binds a resource's `useUpdate` hook to one record's id, for a detail page's
 * inline edits.
 *
 * Every detail page had its own three-line `use<X>Patch` doing exactly this,
 * and every one of them discarded `update.error`. `InlineEdit`'s `onChange` has
 * no return value to reject, so a failed `PATCH` — a duplicate email or domain,
 * a dropped connection — had nowhere left to surface: the field just reverted
 * to its old value with no explanation. Callers now get the error back and
 * decide where to show it.
 */
export function usePatch<TRecord extends { readonly id: string }, TChanges>(
  useUpdate: () => MutationResult<UpdateArguments<TChanges>, TRecord>,
  record: TRecord,
): PatchResult<TChanges> {
  const update = useUpdate()

  return {
    patch: (changes) => {
      update.run({ id: record.id, changes })
    },
    error: update.error,
  }
}
