import { describe, expect, it } from 'vitest'

import { resolveClientIpFrom } from './clientIp.ts'

describe('resolveClientIpFrom', () => {
  it('uses the socket address and ignores the header when no proxy is trusted', () => {
    expect(resolveClientIpFrom('203.0.113.9', '1.2.3.4', 0)).toBe('203.0.113.9')
  })

  it('uses the socket address when there is no forwarded header', () => {
    expect(resolveClientIpFrom('203.0.113.9', undefined, 2)).toBe('203.0.113.9')
  })

  it('reads the client past one trusted proxy', () => {
    // The load balancer wrote the real client on the right; one hop is trusted.
    expect(resolveClientIpFrom('10.0.0.1', '203.0.113.9', 1)).toBe('203.0.113.9')
  })

  it('reads the client past two trusted proxies', () => {
    expect(resolveClientIpFrom('10.0.0.2', '203.0.113.9, 10.0.0.1', 2)).toBe('203.0.113.9')
  })

  it('does not trust a client-forged entry to the left of the trusted hops', () => {
    // The client sent "evil" before reaching the proxies. With one trusted hop
    // the real client is the last entry, not the forged first one.
    expect(resolveClientIpFrom('10.0.0.1', 'evil, 203.0.113.9', 1)).toBe('203.0.113.9')
  })

  it('falls back to the socket address when the header has fewer entries than hops', () => {
    expect(resolveClientIpFrom('10.0.0.1', '203.0.113.9', 3)).toBe('10.0.0.1')
  })
})
