import type { ApiClient, QueryParameters } from '../api/client.ts'

/**
 * One `ApiClient` stand-in for every UI test.
 *
 * Three test files used to hand-write their own, so a method added to
 * `ApiClient` broke all three at once and each had to be fixed separately. It
 * happened for `patchEmpty`, then again for `getText` and `postForm`. This is
 * the one file that now has to change.
 *
 * A method a test did not stub throws, naming the verb and the path. An
 * unexpected request is then a readable failure rather than a hang or a
 * confusing decode error somewhere downstream.
 *
 * Stubs answer with **wire** shapes, not records: the decoder each hook passes
 * runs the way it does in the browser, so a schema that stops matching the API
 * fails a test rather than being bypassed.
 */

/** A list response before decoding, as `client.list` assembles one. */
export interface WirePage {
  readonly items: readonly unknown[]
  readonly nextCursor: string | null
}

/**
 * What a test chooses to answer. Everything is optional; anything left out
 * throws when it is called.
 *
 * Each may return a value or a promise, so a test that does not care about
 * timing can return a literal.
 */
export interface ClientStubs {
  readonly get?: (path: string, query: QueryParameters | undefined) => Promise<unknown> | unknown
  readonly getText?: (path: string) => Promise<string> | string
  readonly list?: (path: string, query: QueryParameters | undefined) => Promise<WirePage> | WirePage
  readonly post?: (path: string, body: unknown) => Promise<unknown> | unknown
  readonly postForm?: (path: string, form: FormData) => Promise<unknown> | unknown
  readonly postEmpty?: (path: string, body: unknown) => Promise<void> | void
  readonly patch?: (path: string, body: unknown) => Promise<unknown> | unknown
  readonly patchEmpty?: (path: string, body: unknown) => Promise<void> | void
  readonly delete?: (path: string, query: QueryParameters | undefined) => Promise<void> | void
}

function required<TStub>(stub: TStub | undefined, verb: string, path: string): TStub {
  if (stub === undefined) {
    throw new Error(`Unexpected ${verb} ${path}`)
  }

  return stub
}

export function stubClient(stubs: ClientStubs): ApiClient {
  return {
    get: async (path, decode, query) =>
      decode(await required(stubs.get, 'get', path)(path, query)),
    getText: async (path) => required(stubs.getText, 'getText', path)(path),
    list: async (path, decodeItem, query) => {
      const wire = await required(stubs.list, 'list', path)(path, query)

      return { items: wire.items.map(decodeItem), nextCursor: wire.nextCursor }
    },
    post: async (path, body, decode) => decode(await required(stubs.post, 'post', path)(path, body)),
    postForm: async (path, form, decode) =>
      decode(await required(stubs.postForm, 'postForm', path)(path, form)),
    postEmpty: async (path, body) => {
      await required(stubs.postEmpty, 'postEmpty', path)(path, body)
    },
    patch: async (path, body, decode) =>
      decode(await required(stubs.patch, 'patch', path)(path, body)),
    patchEmpty: async (path, body) => {
      await required(stubs.patchEmpty, 'patchEmpty', path)(path, body)
    },
    delete: async (path, query) => {
      await required(stubs.delete, 'delete', path)(path, query)
    },
  }
}
