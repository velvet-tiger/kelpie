import { describe, expect, it } from 'vitest'

import { ApiError, createApiClient } from './client.ts'

/**
 * `deleteWithBody`, the one call that sends a body on a `DELETE`: deleting
 * the account, which needs the current password and must not put it in the
 * URL.
 */

interface Sent {
  readonly url: string
  readonly method: string | undefined
  readonly body: unknown
}

function clientAnswering(response: Response, sent: Sent[]): ReturnType<typeof createApiClient> {
  return createApiClient({
    baseUrl: 'https://kelpie.test/v1',
    fetch: (input, init) => {
      sent.push({
        url: String(input),
        method: init?.method,
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body,
      })

      return Promise.resolve(response)
    },
  })
}

describe('deleteWithBody', () => {
  it('sends a DELETE with the JSON body and no query string, and resolves on 204', async () => {
    const sent: Sent[] = []
    const client = clientAnswering(new Response(null, { status: 204 }), sent)

    await client.deleteWithBody('/account', { current_password: 'correct horse battery staple' })

    expect(sent).toEqual([
      {
        url: 'https://kelpie.test/v1/account',
        method: 'DELETE',
        body: { current_password: 'correct horse battery staple' },
      },
    ])
  })

  it('rejects with the API error the server answered', async () => {
    const client = clientAnswering(
      Response.json(
        { error: { code: 'unauthorized', message: 'Current password is incorrect' } },
        { status: 401 },
      ),
      [],
    )

    const refusal: unknown = await client
      .deleteWithBody('/account', { current_password: 'wrong' })
      .catch((thrown: unknown) => thrown)

    expect(refusal).toBeInstanceOf(ApiError)
    expect(refusal).toMatchObject({ status: 401, message: 'Current password is incorrect' })
  })
})
