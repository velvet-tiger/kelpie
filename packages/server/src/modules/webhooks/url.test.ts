import { describe, expect, it } from 'vitest'

import { isDeliverableUrl, urlProblem } from './url.ts'

describe('urlProblem', () => {
  it('accepts an https endpoint', () => {
    expect(urlProblem('https://example.com/webhooks/kelpie')).toBeUndefined()
  })

  /** A self-hosted install legitimately posts to an internal host over http. */
  it('accepts plain http, including a private host and a port', () => {
    expect(isDeliverableUrl('http://automation.internal:8080/hooks')).toBe(true)
    expect(isDeliverableUrl('http://127.0.0.1:9000/hooks')).toBe(true)
  })

  it('refuses a relative path', () => {
    expect(urlProblem('/hooks/kelpie')?.message).toMatch(/absolute URL/u)
  })

  it('refuses a protocol nothing can be posted to', () => {
    expect(urlProblem('ftp://example.com/hooks')?.message).toMatch(/http:\/\/ or https:\/\//u)
    expect(urlProblem('javascript:alert(1)')?.message).toMatch(/http:\/\/ or https:\/\//u)
  })

  it('refuses credentials in the URL', () => {
    expect(urlProblem('https://user:pass@example.com/hooks')?.message).toMatch(/credentials/u)
    expect(urlProblem('https://user@example.com/hooks')?.message).toMatch(/credentials/u)
  })

  it('refuses an empty string', () => {
    expect(isDeliverableUrl('')).toBe(false)
  })
})
