import { describe, expect, it } from 'vitest'

import { BlockedEgressError } from './egress.ts'
import { describeOutboundFailure } from './outbound.ts'

describe('describeOutboundFailure', () => {
  const refused = Object.assign(new Error('connect ECONNREFUSED 10.0.0.5:443'), { code: 'ECONNREFUSED' })

  it('keeps the address out of the reason and gives it to the log detail', () => {
    const failure = describeOutboundFailure(new TypeError('fetch failed', { cause: refused }))

    expect(failure).toEqual({
      reason: 'TypeError: fetch failed (ECONNREFUSED)',
      kelpieFault: false,
      logDetail: 'Error: ECONNREFUSED: connect ECONNREFUSED 10.0.0.5:443',
    })
  })

  it('counts a resolver that did not answer as Kelpie’s fault, from the check and from fetch', () => {
    const dns = Object.assign(new Error('getaddrinfo EAI_AGAIN example.com'), { code: 'EAI_AGAIN' })

    expect(describeOutboundFailure(dns).kelpieFault).toBe(true)
    expect(describeOutboundFailure(new TypeError('fetch failed', { cause: dns })).kelpieFault).toBe(true)
    expect(describeOutboundFailure(new TypeError('fetch failed', { cause: refused })).kelpieFault).toBe(false)
  })

  it('names the address the guard refused for the log only', () => {
    const failure = describeOutboundFailure(new BlockedEgressError('example.com', '10.0.0.5'))

    expect(failure.blockedAddress).toBe('10.0.0.5')
    expect(failure.reason).not.toContain('10.0.0.5')
  })
})
