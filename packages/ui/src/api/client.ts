/**
 * Client for the public `/v1` API. The UI is one more API consumer, exactly like
 * an agent, so this file encodes only what `api.md` documents: the list envelope,
 * the error shape, and the write verbs.
 *
 * Responses are untrusted input. Every method takes a `Decoder` and returns what
 * the decoder produced, so nothing is asserted into a type it was not checked
 * against.
 */

import { isRecord } from './json.ts'

export type Decoder<T> = (value: unknown) => T

export interface ErrorDetail {
  readonly field: string
  readonly message: string
}

/** A `{ error: … }` response rendered as a throwable. */
export class ApiError extends Error {
  readonly code: string
  readonly status: number
  readonly details: readonly ErrorDetail[]

  constructor(status: number, code: string, message: string, details: readonly ErrorDetail[] = []) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
    this.details = details
  }
}

/** A cursor page: `{ data, next_cursor }` from `api.md`. */
export interface Page<T> {
  readonly items: readonly T[]
  readonly nextCursor: string | null
}

export type QueryParameters = Readonly<Record<string, string | number | boolean | undefined>>

export interface ApiClientOptions {
  /** Origin plus base path, e.g. `/v1` in the browser or `http://localhost:3000/v1` in tests. */
  readonly baseUrl: string
  readonly fetch?: typeof globalThis.fetch
}

export interface ApiClient {
  get<T>(path: string, decode: Decoder<T>, query?: QueryParameters): Promise<T>
  list<T>(path: string, decodeItem: Decoder<T>, query?: QueryParameters): Promise<Page<T>>
  post<T>(path: string, body: unknown, decode: Decoder<T>): Promise<T>
  patch<T>(path: string, body: unknown, decode: Decoder<T>): Promise<T>
  delete(path: string): Promise<void>
}

function isErrorDetail(value: unknown): value is ErrorDetail {
  return isRecord(value) && typeof value.field === 'string' && typeof value.message === 'string'
}

function buildUrl(baseUrl: string, path: string, query: QueryParameters | undefined): string {
  const search = new URLSearchParams()

  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined) {
      search.set(key, String(value))
    }
  }

  const queryString = search.toString()
  return queryString.length > 0 ? `${baseUrl}${path}?${queryString}` : `${baseUrl}${path}`
}

/**
 * Turns a failed response into an `ApiError`. A body that does not match the
 * documented error shape still produces an error carrying the HTTP status,
 * because the alternative is a rejected promise with no cause.
 */
function readErrorBody(status: number, payload: unknown): ApiError {
  const unreadable = new ApiError(status, 'internal_error', `Unreadable error response (HTTP ${status})`)

  if (!isRecord(payload) || !isRecord(payload.error)) {
    return unreadable
  }

  const { code, message, details } = payload.error

  if (typeof code !== 'string' || typeof message !== 'string') {
    return unreadable
  }

  return new ApiError(status, code, message, Array.isArray(details) ? details.filter(isErrorDetail) : [])
}

function readPage<T>(payload: unknown, decodeItem: Decoder<T>): Page<T> {
  if (!isRecord(payload) || !Array.isArray(payload.data)) {
    throw new TypeError('Expected a list envelope with a "data" array')
  }

  const nextCursor = payload.next_cursor

  if (nextCursor !== null && typeof nextCursor !== 'string') {
    throw new TypeError('Expected "next_cursor" to be a string or null')
  }

  return { items: payload.data.map((item: unknown) => decodeItem(item)), nextCursor }
}

export function createApiClient(options: ApiClientOptions): ApiClient {
  const doFetch = options.fetch ?? globalThis.fetch.bind(globalThis)

  function headersFor(body: unknown): Record<string, string> {
    return body === undefined
      ? { Accept: 'application/json' }
      : { Accept: 'application/json', 'Content-Type': 'application/json' }
  }

  function request(method: string, url: string, body?: unknown): Promise<Response> {
    return doFetch(url, {
      method,
      credentials: 'same-origin',
      headers: headersFor(body),
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  }

  /** Reads a JSON response, converting any non-2xx into an `ApiError`. */
  async function readJson(response: Response): Promise<unknown> {
    const payload: unknown = await response.json()

    if (!response.ok) {
      throw readErrorBody(response.status, payload)
    }

    return payload
  }

  async function send<T>(method: string, url: string, decode: Decoder<T>, body?: unknown): Promise<T> {
    return decode(await readJson(await request(method, url, body)))
  }

  return {
    get: (path, decode, query) => send('GET', buildUrl(options.baseUrl, path, query), decode),

    list: async (path, decodeItem, query) =>
      readPage(await readJson(await request('GET', buildUrl(options.baseUrl, path, query))), decodeItem),

    post: (path, body, decode) => send('POST', buildUrl(options.baseUrl, path, undefined), decode, body),

    patch: (path, body, decode) => send('PATCH', buildUrl(options.baseUrl, path, undefined), decode, body),

    delete: async (path) => {
      const response = await request('DELETE', buildUrl(options.baseUrl, path, undefined))

      if (response.status !== 204) {
        throw readErrorBody(response.status, await response.json())
      }
    },
  }
}
