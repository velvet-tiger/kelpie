import type { Hono } from 'hono'

import type { AppBindings } from '../app.ts'

/**
 * An HTTP client for integration tests, plus the two setups almost every suite
 * needs first: an account, and an account that owns a workspace.
 *
 * Requests go through `app.request`, so they run the real middleware chain,
 * routing, and error rendering. Nothing here reaches around the API.
 */

export interface TestRequestOptions {
  readonly body?: unknown
  readonly cookie?: string | undefined
  readonly bearer?: string | undefined
}

/** A signed-in owner of a fresh workspace: what most CRM tests start from. */
export interface TestOwner {
  readonly cookie: string
  readonly workspaceId: string
}

export interface TestClient {
  send(method: string, path: string, options?: TestRequestOptions): Promise<Response>
  /** @returns The session cookie for the new account. */
  signUp(email: string): Promise<string>
  owner(email?: string, slug?: string): Promise<TestOwner>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** Reads a field a response is expected to carry, failing with the body when it does not. */
export function readString(payload: unknown, key: string): string {
  if (!isRecord(payload) || typeof payload[key] !== 'string') {
    throw new Error(`Expected "${key}" on ${JSON.stringify(payload)}`)
  }

  return payload[key]
}

export function readRecord(payload: unknown): Record<string, unknown> {
  if (!isRecord(payload)) {
    throw new Error(`Expected an object, got ${JSON.stringify(payload)}`)
  }

  return payload
}

/** Reads the `data` array out of a `{ data, next_cursor }` envelope. */
export function readList(payload: unknown): Record<string, unknown>[] {
  if (!isRecord(payload) || !Array.isArray(payload.data)) {
    throw new Error(`Expected a list envelope, got ${JSON.stringify(payload)}`)
  }

  return payload.data.filter(isRecord)
}

/** Reads `next_cursor`, which is a string or null and never absent. */
export function readCursor(payload: unknown): string | null {
  if (!isRecord(payload) || (payload.next_cursor !== null && typeof payload.next_cursor !== 'string')) {
    throw new Error(`Expected "next_cursor" on ${JSON.stringify(payload)}`)
  }

  return payload.next_cursor
}

export function createTestClient(app: Hono<AppBindings>): TestClient {
  function send(method: string, path: string, options: TestRequestOptions = {}): Promise<Response> {
    return Promise.resolve(
      app.request(path, {
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(options.cookie === undefined ? {} : { Cookie: options.cookie }),
          ...(options.bearer === undefined ? {} : { Authorization: `Bearer ${options.bearer}` }),
        },
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      }),
    )
  }

  async function signUp(email: string): Promise<string> {
    const response = await send('POST', '/v1/auth/signup', {
      body: { email, name: 'Someone', password: 'correct horse battery staple' },
    })

    if (response.status !== 201) {
      throw new Error(`Signing up ${email} answered ${String(response.status)}`)
    }

    // Only the cookie's name=value matters to a later request; the attributes
    // after the first semicolon are for a browser.
    return (response.headers.get('Set-Cookie') ?? '').split(';')[0] ?? ''
  }

  return {
    send,
    signUp,

    async owner(email = 'ada@example.com', slug = 'acme') {
      const cookie = await signUp(email)
      const created = await send('POST', '/v1/workspaces', {
        body: { name: 'Acme', slug, timezone: 'Australia/Melbourne' },
        cookie,
      })

      if (created.status !== 201) {
        throw new Error(`Creating workspace ${slug} answered ${String(created.status)}`)
      }

      return { cookie, workspaceId: readString(await created.json(), 'id') }
    },
  }
}
