import { describe, expect, it } from 'vitest'

import { rateLimitKeyForIp, resolveClientIpFrom } from './clientIp.ts'

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

describe('rateLimitKeyForIp', () => {
  it('leaves an IPv4 address unchanged', () => {
    expect(rateLimitKeyForIp('203.0.113.9')).toBe('203.0.113.9')
  })

  it('gives every address in one IPv6 /64 the same key', () => {
    const first = rateLimitKeyForIp('2001:db8:1:2:aaaa:bbbb:cccc:dddd')

    expect(first).toBe('2001:db8:1:2::/64')
    expect(rateLimitKeyForIp('2001:db8:1:2::1')).toBe(first)
    expect(rateLimitKeyForIp('2001:0DB8:0001:0002:ffff:ffff:ffff:ffff')).toBe(first)
  })

  it('gives a different IPv6 /64 a different key', () => {
    expect(rateLimitKeyForIp('2001:db8:1:3::1')).toBe('2001:db8:1:3::/64')
    expect(rateLimitKeyForIp('2001:db8:1:3::1')).not.toBe(rateLimitKeyForIp('2001:db8:1:2::1'))
  })

  it('reduces an IPv4-mapped IPv6 address to the IPv4 address', () => {
    expect(rateLimitKeyForIp('::ffff:203.0.113.9')).toBe('203.0.113.9')
    expect(rateLimitKeyForIp('::ffff:cb00:7109')).toBe('203.0.113.9')
  })

  it('ignores an IPv6 zone identifier', () => {
    expect(rateLimitKeyForIp('fe80::1%eth0')).toBe('fe80:0:0:0::/64')
  })

  it('returns a value that is not an address unchanged', () => {
    expect(rateLimitKeyForIp('unknown')).toBe('unknown')
    expect(rateLimitKeyForIp('')).toBe('')
  })
})
