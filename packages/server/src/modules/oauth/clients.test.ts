import { describe, expect, it } from 'vitest'

import { BlockedEgressError } from '../../lib/egress.ts'
import type { EgressGuard } from '../../lib/egress.ts'
import { CLIENT_METADATA_REFUSED, OAuthClientError, fetchClientMetadata, redirectUriProblem } from './clients.ts'
import type { Fetch } from './clients.ts'

/**
 * The two rules of `clients.ts` that take no database: which redirect URIs a
 * client may have, and what a caller learns when a metadata document fails.
 */

describe('redirectUriProblem', () => {
  it.each([
    'https://client.example/callback',
    'https://client.example:8443/callback?tenant=1',
    'http://localhost/callback',
    'http://localhost:33418/callback',
    'http://127.0.0.1:33418/callback',
    'http://[::1]:33418/callback',
    'cursor://anysphere.cursor-mcp/oauth/callback',
    'vscode://publisher.extension/callback',
    'vscode-insiders://publisher.extension/callback',
    'windsurf://callback',
    'com.example.app:/oauth2redirect',
    'com.example.app://callback',
    'COM.Example.App:/oauth2redirect',
  ])('allows %s', (uri) => {
    expect(redirectUriProblem(uri)).toBeUndefined()
  })

  it.each([
    // What the earlier list named.
    'javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'vbscript:msgbox(1)',
    'file:///etc/passwd',
    'blob:https://client.example/3f1c',
    'about:blank',
    'ws://client.example/callback',
    'wss://client.example/callback',
    // What it did not name. An allowlist refuses these with no entry for them.
    'ftp://client.example/callback',
    'intent://callback#Intent;scheme=x;end',
    'intent://callback',
    'mailto:someone@example.com',
    'tel:+61400000000',
    'sms:+61400000000',
    'view-source:https://client.example/',
    'chrome://settings/',
    'ms-msdt:/id',
    'jar:https://client.example/a.jar!/',
    'myapp://callback',
    'x:/callback',
    // A dot in the wrong place does not make a reverse domain name.
    '.app:/callback',
    // Plain HTTP anywhere but a loopback address.
    'http://client.example/callback',
    'http://127.0.0.2/callback',
    'http://localhost.client.example/callback',
    'http://169.254.169.254/latest/meta-data',
    // Allowed schemes that break another rule.
    'https://client.example/callback#fragment',
    'https://user:secret@client.example/callback',
    'com.example.app:/callback#fragment',
    // Not URLs.
    '/callback',
    'client.example/callback',
    '',
  ])('refuses %s', (uri) => {
    expect(redirectUriProblem(uri)).toEqual(expect.any(String))
  })
})

describe('fetchClientMetadata', () => {
  const CLIENT_ID = 'https://client.example/oauth/metadata.json'
  const DOCUMENT = {
    client_id: CLIENT_ID,
    client_name: 'Example Agent',
    redirect_uris: ['https://client.example/callback'],
    token_endpoint_auth_method: 'none',
  }
  const openGuard: EgressGuard = { check: () => Promise.resolve(), fetch }

  function answer(body: string, status = 200): Fetch {
    return () => Promise.resolve(new Response(status === 204 ? null : body, { status }))
  }

  async function refusal(
    fetchDocument: Fetch,
    egress: EgressGuard = openGuard,
    clientId = CLIENT_ID,
  ): Promise<OAuthClientError> {
    try {
      await fetchClientMetadata(clientId, { egress, fetch: fetchDocument })
    } catch (error: unknown) {
      if (error instanceof OAuthClientError) {
        return error
      }

      throw error
    }

    throw new Error('Expected the metadata document to be refused')
  }

  it('reads a valid document', async () => {
    const fetched = await fetchClientMetadata(CLIENT_ID, { egress: openGuard, fetch: answer(JSON.stringify(DOCUMENT)) })

    expect(fetched).toEqual({
      clientName: 'Example Agent',
      clientUri: null,
      logoUri: null,
      redirectUris: ['https://client.example/callback'],
    })
  })

  it('asks once, follows no redirect, and sets a time limit', async () => {
    const calls: { input: string; init: RequestInit }[] = []
    const redirecting: Fetch = (input, init) => {
      calls.push({ input, init })

      return Promise.resolve(
        new Response(null, { status: 302, headers: { Location: 'http://169.254.169.254/latest/meta-data' } }),
      )
    }
    const error = await refusal(redirecting)

    expect(calls).toHaveLength(1)
    expect(calls[0]?.input).toBe(CLIENT_ID)
    expect(calls[0]?.init.redirect).toBe('manual')
    expect(calls[0]?.init.signal).toBeInstanceOf(AbortSignal)
    expect(error.message).toBe(CLIENT_METADATA_REFUSED)
    expect(error.logReason).toBe('the host answered 302')
  })

  it('stops reading a document that is larger than the limit', async () => {
    let pulled = 0
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1
        controller.enqueue(new Uint8Array(16 * 1024).fill(0x20))
      },
    })
    const error = await refusal(() => Promise.resolve(new Response(endless, { status: 200 })))

    expect(error.logReason).toBe('the document is larger than 65536 bytes')
    // 64 KB is four chunks. The stream may run one or two ahead of the reader.
    expect(pulled).toBeLessThan(10)
  })

  /**
   * Each row is one thing a host of the caller's choice could do. The caller
   * must not be able to tell the rows apart, so each gives the one message and
   * the one code. The reason differs, and only the log gets it.
   */
  const SECRET = 'internal-admin-token-41c9'
  const failures: readonly { name: string; fetch: Fetch; egress?: EgressGuard; reason: RegExp }[] = [
    {
      name: 'an address the guard refuses before the request',
      fetch: answer(JSON.stringify(DOCUMENT)),
      egress: { check: () => Promise.reject(new BlockedEgressError('client.example', '10.0.0.5')), fetch },
      // The address is in the error's field and not in its message. The log still gets it.
      reason: /^Refusing to connect to client\.example: .+ private or reserved address \(10\.0\.0\.5\)$/u,
    },
    {
      name: 'a host with no address',
      fetch: answer(JSON.stringify(DOCUMENT)),
      egress: { check: () => Promise.reject(new Error('getaddrinfo ENOTFOUND client.example')), fetch },
      reason: /^the host could not be checked: Error: getaddrinfo ENOTFOUND/u,
    },
    {
      name: 'an address the guard refuses at the connection',
      fetch: () => Promise.reject(new BlockedEgressError('client.example', '10.0.0.5')),
      reason: /^the request failed: BlockedEgressError: Refusing to connect to client\.example: .+ \(10\.0\.0\.5\)$/u,
    },
    {
      name: 'a host that does not answer',
      fetch: () => Promise.reject(new TypeError('fetch failed')),
      reason: /^the request failed: TypeError: fetch failed$/u,
    },
    {
      name: 'a host that is too slow',
      fetch: () => Promise.reject(new DOMException('The operation was aborted due to timeout', 'TimeoutError')),
      reason: /^the request failed: TimeoutError/u,
    },
    { name: 'a 404', fetch: answer(SECRET, 404), reason: /^the host answered 404$/u },
    { name: 'a 401', fetch: answer(SECRET, 401), reason: /^the host answered 401$/u },
    { name: 'a 500', fetch: answer(SECRET, 500), reason: /^the host answered 500$/u },
    { name: 'a 204', fetch: answer('', 204), reason: /^the host answered 204$/u },
    { name: 'a body that is not JSON', fetch: answer(`<html>${SECRET}</html>`), reason: /^the document is not JSON$/u },
    { name: 'an empty body', fetch: answer(''), reason: /^the document is not JSON$/u },
    {
      name: 'JSON that is not a metadata document',
      fetch: answer(JSON.stringify({ password: SECRET })),
      reason: /^the document is missing required fields or has fields of the wrong shape: /u,
    },
    {
      name: 'a document for another client_id',
      fetch: answer(JSON.stringify({ ...DOCUMENT, client_id: `https://other.example/${SECRET}` })),
      reason: /^the document names a different client_id$/u,
    },
    {
      name: 'a document that asks for a client secret',
      fetch: answer(JSON.stringify({ ...DOCUMENT, token_endpoint_auth_method: SECRET })),
      reason: /^the document asks for a token endpoint auth method other than none$/u,
    },
    {
      name: 'a document with a redirect URI that is not allowed',
      fetch: answer(JSON.stringify({ ...DOCUMENT, redirect_uris: [`javascript:${SECRET}`] })),
      reason: /^the document lists a redirect URI that is not allowed$/u,
    },
  ]

  it.each(failures)('says the one thing to the caller for $name', async (failure) => {
    const error = await refusal(failure.fetch, failure.egress)

    expect(error.code).toBe('invalid_client')
    expect(error.message).toBe(CLIENT_METADATA_REFUSED)
    expect(error.logReason).toMatch(failure.reason)
    // Nothing the host sent as a body reaches the caller or the log.
    expect(error.logReason).not.toContain(SECRET)
  })
})
