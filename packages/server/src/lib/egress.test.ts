import { describe, expect, it } from 'vitest'

import { BlockedEgressError, createEgressGuard } from './egress.ts'

/**
 * The resolver is injected, so these cases never touch real DNS. A literal
 * address is classified without the resolver at all; a hostname goes through it.
 */

const literalOnly = () => Promise.reject(new Error('a literal must not be resolved'))

describe('createEgressGuard', () => {
  it('is a no-op when blocking is off, whatever the host resolves to', async () => {
    const guard = createEgressGuard({ BLOCK_PRIVATE_EGRESS: false }, () => Promise.resolve(['127.0.0.1']))

    await expect(guard.check('http://anything.internal/x')).resolves.toBeUndefined()
  })

  describe('with blocking on', () => {
    function guardResolving(addresses: readonly string[]): ReturnType<typeof createEgressGuard> {
      return createEgressGuard({ BLOCK_PRIVATE_EGRESS: true }, () => Promise.resolve(addresses))
    }

    it('allows a host that resolves only to a public address', async () => {
      await expect(guardResolving(['93.184.216.34']).check('https://example.com/hook')).resolves.toBeUndefined()
    })

    it('refuses a private IPv4 literal without resolving', async () => {
      const guard = createEgressGuard({ BLOCK_PRIVATE_EGRESS: true }, literalOnly)

      await expect(guard.check('http://10.0.0.5/x')).rejects.toBeInstanceOf(BlockedEgressError)
      await expect(guard.check('http://192.168.1.1/x')).rejects.toBeInstanceOf(BlockedEgressError)
      await expect(guard.check('http://127.0.0.1/x')).rejects.toBeInstanceOf(BlockedEgressError)
    })

    it('refuses the cloud metadata address', async () => {
      const guard = createEgressGuard({ BLOCK_PRIVATE_EGRESS: true }, literalOnly)

      await expect(guard.check('http://169.254.169.254/latest/meta-data/')).rejects.toBeInstanceOf(
        BlockedEgressError,
      )
    })

    it('refuses a hostname that resolves to a private address', async () => {
      await expect(guardResolving(['127.0.0.1']).check('https://sneaky.example/x')).rejects.toBeInstanceOf(
        BlockedEgressError,
      )
    })

    it('refuses when any one resolved address is private', async () => {
      await expect(
        guardResolving(['93.184.216.34', '10.1.2.3']).check('https://mixed.example/x'),
      ).rejects.toBeInstanceOf(BlockedEgressError)
    })

    it('refuses IPv6 loopback and unique-local literals', async () => {
      const guard = createEgressGuard({ BLOCK_PRIVATE_EGRESS: true }, literalOnly)

      await expect(guard.check('http://[::1]/x')).rejects.toBeInstanceOf(BlockedEgressError)
      await expect(guard.check('http://[fd00::1]/x')).rejects.toBeInstanceOf(BlockedEgressError)
      await expect(guard.check('http://[fe80::1]/x')).rejects.toBeInstanceOf(BlockedEgressError)
    })

    it('allows a public IPv6 literal', async () => {
      const guard = createEgressGuard({ BLOCK_PRIVATE_EGRESS: true }, literalOnly)

      await expect(
        guard.check('http://[2606:2800:220:1:248:1893:25c8:1946]/x'),
      ).resolves.toBeUndefined()
    })
  })
})
