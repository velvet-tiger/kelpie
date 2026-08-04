import { toError } from '../errors.ts'
import type { MutationResult } from '../resource.ts'

/**
 * Adapts one TanStack mutation to the `MutationResult` pages consume.
 *
 * `createResourceHooks` does this for the five CRM verbs. The endpoints that are
 * not a CRM collection — the session, the workspace, membership, invitations —
 * still hand pages the same three fields, so a page never learns which kind of
 * hook it is calling.
 */

interface MutationLike<TInput, TOutput> {
  mutate: (input: TInput) => void
  mutateAsync: (input: TInput) => Promise<TOutput>
  isPending: boolean
  error: unknown
}

export function asMutationResult<TInput, TOutput>(
  mutation: MutationLike<TInput, TOutput>,
): MutationResult<TInput, TOutput> {
  return {
    run: (input) => {
      mutation.mutate(input)
    },
    runAsync: (input) => mutation.mutateAsync(input),
    isPending: mutation.isPending,
    error: toError(mutation.error),
  }
}
