import { createServer } from 'node:http'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'

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

    /**
     * A sender stores the message where the person who typed the URL reads it.
     * What the name resolves to is for the log, so it is a field and not text.
     */
    it('names the host in the message, and gives the address it refused as a field', async () => {
      await expect(
        guardResolving(['93.184.216.34', '10.1.2.3']).check('https://mixed.example/x'),
      ).rejects.toMatchObject({
        message: 'Refusing to connect to mixed.example: the host has a private or reserved address',
        address: '10.1.2.3',
      })
    })

    it('refuses IPv6 loopback and unique-local literals', async () => {
      const guard = createEgressGuard({ BLOCK_PRIVATE_EGRESS: true }, literalOnly)

      await expect(guard.check('http://[::1]/x')).rejects.toBeInstanceOf(BlockedEgressError)
      await expect(guard.check('http://[fd00::1]/x')).rejects.toBeInstanceOf(BlockedEgressError)
      await expect(guard.check('http://[fe80::1]/x')).rejects.toBeInstanceOf(BlockedEgressError)
    })

    it.each([
      '::ffff:127.0.0.1',
      '::ffff:7f00:1',
      '0:0:0:0:0:ffff:7f00:1',
      '::ffff:10.0.0.5',
      '::ffff:172.16.0.1',
      '::ffff:192.168.1.1',
      '::ffff:169.254.169.254',
    ])('refuses private mapped IPv6 address %s as a literal and DNS result', async (address) => {
      const guard = createEgressGuard({ BLOCK_PRIVATE_EGRESS: true }, literalOnly)

      await expect(guard.check(`http://[${address}]/x`)).rejects.toBeInstanceOf(BlockedEgressError)
      await expect(
        guardResolving([address]).check('https://sneaky.example/x'),
      ).rejects.toBeInstanceOf(BlockedEgressError)
    })

    it('refuses an expanded IPv6 loopback returned by DNS', async () => {
      await expect(
        guardResolving(['0:0:0:0:0:0:0:1']).check('https://sneaky.example/x'),
      ).rejects.toBeInstanceOf(BlockedEgressError)
    })

    it('allows mapped IPv6 addresses with a public IPv4 destination', async () => {
      const guard = createEgressGuard({ BLOCK_PRIVATE_EGRESS: true }, literalOnly)

      await expect(guard.check('http://[::ffff:93.184.216.34]/x')).resolves.toBeUndefined()
      await expect(
        guardResolving(['0:0:0:0:0:ffff:5db8:d822']).check('https://example.com/x'),
      ).resolves.toBeUndefined()
    })

    it('allows a public IPv6 literal', async () => {
      const guard = createEgressGuard({ BLOCK_PRIVATE_EGRESS: true }, literalOnly)

      await expect(
        guard.check('http://[2606:2800:220:1:248:1893:25c8:1946]/x'),
      ).resolves.toBeUndefined()
    })

    it.each([
      ['NAT64', '64:ff9b::7f00:1'],
      ['6to4', '2002:7f00:1::1'],
      ['Teredo', '2001::1'],
      ['IPv4-compatible', '::7f00:1'],
      ['IPv4-compatible, dotted', '::127.0.0.1'],
      ['benchmarking', '198.18.0.1'],
      ['IETF protocol assignments', '192.0.0.1'],
      ['documentation', '2001:db8::1'],
    ])('refuses a %s address as a literal and as a DNS result', async (_name, address) => {
      const guard = createEgressGuard({ BLOCK_PRIVATE_EGRESS: true }, literalOnly)
      const literal = address.includes(':') ? `[${address}]` : address

      await expect(guard.check(`http://${literal}/x`)).rejects.toBeInstanceOf(BlockedEgressError)
      await expect(
        guardResolving([address]).check('https://sneaky.example/x'),
      ).rejects.toBeInstanceOf(BlockedEgressError)
    })

    it('refuses a DNS result that is not an address', async () => {
      await expect(guardResolving(['not-an-address']).check('https://odd.example/x')).rejects.toBeInstanceOf(
        BlockedEgressError,
      )
    })
  })

  /**
   * The requests go to a real server on loopback, so these cases show what
   * the socket connects to, not what the guard was told.
   */
  describe('fetch', () => {
    let server: Server | undefined

    afterEach(async () => {
      await new Promise<void>((resolve) => {
        if (server === undefined) {
          resolve()
        } else {
          server.close(() => {
            resolve()
          })
        }
      })
      server = undefined
    })

    /** A server on loopback that counts the requests it gets. */
    async function listen(): Promise<{ readonly port: number; readonly hits: () => number }> {
      let hits = 0
      const created = createServer((_request, response) => {
        hits += 1
        response.end('ok')
      })

      server = created
      await new Promise<void>((resolve) => {
        created.listen(0, '127.0.0.1', resolve)
      })

      return { port: (created.address() as AddressInfo).port, hits: () => hits }
    }

    it('is the plain fetch when blocking is off', async () => {
      const { port, hits } = await listen()
      const guard = createEgressGuard({ BLOCK_PRIVATE_EGRESS: false })

      expect((await guard.fetch(`http://127.0.0.1:${String(port)}/x`)).status).toBe(200)
      expect(hits()).toBe(1)
    })

    it('refuses a private literal and sends nothing', async () => {
      const { port, hits } = await listen()
      const guard = createEgressGuard({ BLOCK_PRIVATE_EGRESS: true }, literalOnly)

      await expect(guard.fetch(`http://127.0.0.1:${String(port)}/x`)).rejects.toBeInstanceOf(BlockedEgressError)
      expect(hits()).toBe(0)
    })

    /**
     * DNS rebinding: the host has a public address when `check` looks, and a
     * private one when the connection looks. `localhost` is used so that a
     * fetch with its own lookup really does reach the server.
     */
    it('refuses a host whose address changes after the check, and sends nothing', async () => {
      const { port, hits } = await listen()
      const answers = [['93.184.216.34'], ['127.0.0.1']]
      const guard = createEgressGuard({ BLOCK_PRIVATE_EGRESS: true }, () =>
        Promise.resolve(answers.shift() ?? ['127.0.0.1']),
      )
      const url = `http://localhost:${String(port)}/x`

      await expect(guard.check(url)).resolves.toBeUndefined()
      await expect(guard.fetch(url)).rejects.toBeInstanceOf(BlockedEgressError)
      expect(hits()).toBe(0)
    })

    it('resolves a hostname through the guard, one time for each connection', async () => {
      let lookups = 0
      const guard = createEgressGuard({ BLOCK_PRIVATE_EGRESS: true }, () => {
        lookups += 1

        // TEST-NET-3 is refused, so the request stops at the lookup.
        return Promise.resolve(['203.0.113.10'])
      })

      await expect(guard.fetch('http://pinned.example/x')).rejects.toBeInstanceOf(BlockedEgressError)
      expect(lookups).toBe(1)
    })

    it('keeps the address out of the message when the connection is what refuses', async () => {
      const guard = createEgressGuard({ BLOCK_PRIVATE_EGRESS: true }, () => Promise.resolve(['203.0.113.10']))

      await expect(guard.fetch('http://pinned.example/x')).rejects.toMatchObject({
        message: 'Refusing to connect to pinned.example: the host has a private or reserved address',
        address: '203.0.113.10',
      })
    })
  })
})
