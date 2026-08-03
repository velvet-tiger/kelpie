/**
 * Normalises what a query or mutation rejected with.
 *
 * `unknown` is honest about what a rejected promise carries, but a component
 * rendering a message needs something with a `message`. `ApiError` already
 * extends `Error`, so a failed request survives this untouched.
 */
export function toError(error: unknown): Error | null {
  if (error === null || error === undefined) {
    return null
  }

  return error instanceof Error ? error : new Error(String(error))
}
