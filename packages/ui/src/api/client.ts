/**
 * Client for the public `/v1` API. The UI is one more API consumer, exactly like
 * an agent, so this file encodes only what `api.md` documents: the list envelope,
 * the error shape, and the write verbs.
 *
 * Responses are untrusted input. Every method takes a `Decoder` and returns what
 * the decoder produced, so nothing is asserted into a type it was not checked
 * against.
 *
 * Roadmap decision 8: decoders come from Zod. A schema's `.parse` already matches
 * `Decoder`, so pass `personSchema.parse` and nothing in this file changes. Do
 * not hand-write a decoder for a new resource.
 *
 * Response schemas cannot live in `@kelpie/server`: importing it here would drag
 * Drizzle, postgres.js, and Node built-ins into the browser bundle. They belong
 * in a package that depends on nothing but Zod.
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

/**
 * Query string values. An array becomes a repeated parameter, which is how
 * `api.md` names a set of ids: `?person_id=per_1&person_id=per_2`.
 */
export type QueryParameters = Readonly<
  Record<string, string | number | boolean | readonly string[] | undefined>
>

export interface ApiClientOptions {
  /** Origin plus base path, e.g. `/v1` in the browser or `http://localhost:3000/v1` in tests. */
  readonly baseUrl: string
  readonly fetch?: typeof globalThis.fetch
}

export interface ApiClient {
  get<T>(path: string, decode: Decoder<T>, query?: QueryParameters): Promise<T>
  /**
   * A `GET` answering something other than JSON. CSV export is the case: the
   * response is a file, and there is nothing to decode.
   */
  getText(path: string): Promise<string>
  list<T>(path: string, decodeItem: Decoder<T>, query?: QueryParameters): Promise<Page<T>>
  post<T>(path: string, body: unknown, decode: Decoder<T>): Promise<T>
  /**
   * A `POST` carrying a file. Creating an import job is the case: base64 in a
   * JSON body would spend a third of the ten megabyte limit on encoding.
   *
   * The body sets its own `Content-Type` with the multipart boundary in it, so
   * unlike `post` this must not name one.
   */
  postForm<T>(path: string, form: FormData, decode: Decoder<T>): Promise<T>
  /**
   * A `POST` whose success carries no body. `api.md` has resource writes return
   * the resulting object, but the session endpoints have nothing to return:
   * logout answers `204`, and a password reset request answers `202`.
   */
  postEmpty(path: string, body?: unknown): Promise<void>
  patch<T>(path: string, body: unknown, decode: Decoder<T>): Promise<T>
  /**
   * A `PATCH` whose success carries no body. Changing a password is the case:
   * it answers `204` because the one thing it changed is the one thing the API
   * will not hand back.
   */
  patchEmpty(path: string, body: unknown): Promise<void>
  /**
   * `query` is for a delete that takes a confirmation, which
   * `DELETE /v1/workspaces/:id?slug=` is. A `DELETE` body would be the other
   * option, and HTTP lets a client drop one.
   */
  delete(path: string, query?: QueryParameters): Promise<void>
}

function isErrorDetail(value: unknown): value is ErrorDetail {
  return isRecord(value) && typeof value.field === 'string' && typeof value.message === 'string'
}

function buildUrl(baseUrl: string, path: string, query: QueryParameters | undefined): string {
  const search = new URLSearchParams()

  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === undefined) {
      continue
    }

    if (Array.isArray(value)) {
      // append, not set: every id has to survive into the query string.
      for (const item of value) {
        search.append(key, item)
      }
    } else {
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

  /**
   * Builds the error for a response that was supposed to have no body. The body
   * is parsed defensively: a proxy answering `502` with HTML would otherwise
   * surface as a JSON syntax error, hiding the status that explains it.
   */
  async function readEmptyError(response: Response): Promise<ApiError> {
    const payload: unknown = await response.json().catch(() => null)

    return readErrorBody(response.status, payload)
  }

  return {
    get: (path, decode, query) => send('GET', buildUrl(options.baseUrl, path, query), decode),

    getText: async (path) => {
      const response = await doFetch(buildUrl(options.baseUrl, path, undefined), {
        method: 'GET',
        credentials: 'same-origin',
        headers: { Accept: 'text/csv' },
      })

      if (!response.ok) {
        throw await readEmptyError(response)
      }

      return response.text()
    },

    postForm: async (path, form, decode) => {
      const response = await doFetch(buildUrl(options.baseUrl, path, undefined), {
        method: 'POST',
        credentials: 'same-origin',
        headers: { Accept: 'application/json' },
        body: form,
      })

      return decode(await readJson(response))
    },

    list: async (path, decodeItem, query) =>
      readPage(await readJson(await request('GET', buildUrl(options.baseUrl, path, query))), decodeItem),

    post: (path, body, decode) => send('POST', buildUrl(options.baseUrl, path, undefined), decode, body),

    postEmpty: async (path, body) => {
      const response = await request('POST', buildUrl(options.baseUrl, path, undefined), body)

      if (!response.ok) {
        throw await readEmptyError(response)
      }
    },

    patch: (path, body, decode) => send('PATCH', buildUrl(options.baseUrl, path, undefined), decode, body),

    patchEmpty: async (path, body) => {
      const response = await request('PATCH', buildUrl(options.baseUrl, path, undefined), body)

      if (!response.ok) {
        throw await readEmptyError(response)
      }
    },

    delete: async (path, query) => {
      const response = await request('DELETE', buildUrl(options.baseUrl, path, query))

      // Stricter than `response.ok`: `api.md` says a successful delete is `204`,
      // and anything else means the server is not doing what it documents.
      if (response.status !== 204) {
        throw await readEmptyError(response)
      }
    },
  }
}
