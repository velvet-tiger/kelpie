import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'

import { requestOrigin } from './http.ts'

/** Runs `requestOrigin` against a real Hono context for the given URL and headers. */
async function originOf(url: string, headers: Record<string, string> = {}): Promise<string> {
  const app = new Hono()

  app.get('*', (context) => context.text(requestOrigin(context)))

  const response = await app.request(url, { headers })

  return response.text()
}

describe('requestOrigin', () => {
  it('is the scheme and host the request arrived on', async () => {
    expect(await originOf('http://crm.example.test/v1/forms')).toBe('http://crm.example.test')
  })

  it('takes https from a proxy that ended TLS', async () => {
    expect(await originOf('http://crm.example.test/v1/forms', { 'X-Forwarded-Proto': 'https' })).toBe(
      'https://crm.example.test',
    )
  })

  it('reads the first entry when proxies append to the header', async () => {
    expect(await originOf('http://crm.example.test/', { 'X-Forwarded-Proto': 'HTTPS, http' })).toBe(
      'https://crm.example.test',
    )
  })

  it('keeps a non-default port', async () => {
    expect(await originOf('http://localhost:8080/', { 'X-Forwarded-Proto': 'https' })).toBe('https://localhost:8080')
  })

  it('ignores a value that is not http or https', async () => {
    expect(await originOf('http://crm.example.test/', { 'X-Forwarded-Proto': 'javascript' })).toBe(
      'http://crm.example.test',
    )
    expect(await originOf('http://crm.example.test/', { 'X-Forwarded-Proto': '' })).toBe('http://crm.example.test')
  })
})
