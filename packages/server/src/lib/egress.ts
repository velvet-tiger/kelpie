import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { z } from 'zod'

/**
 * An optional guard against outbound POSTs to private or reserved addresses.
 *
 * Webhook and agent endpoints are customer-supplied, and a self-hosted Kelpie
 * legitimately posts to an internal host such as `http://automation.internal`.
 * So the guard is off by default (`lib/url.ts` says the same). A hosted
 * deployment, where a customer must not be able to aim a delivery at the
 * metadata service or a neighbour's database, sets `BLOCK_PRIVATE_EGRESS=true`.
 *
 * The check resolves the host and refuses the request when any resolved address
 * is loopback, private, link-local, unique-local, or otherwise reserved. It runs
 * just before the fetch. That leaves a narrow rebinding window between this
 * lookup and the connection's own; the senders already pass `redirect: 'manual'`,
 * which closes the redirect-based bypass, and a hosted deployment pairs this with
 * network-level egress rules. It is defence in depth, not the only defence.
 */

export const egressConfigSchema = z.object({
  BLOCK_PRIVATE_EGRESS: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
})

export type EgressConfig = z.infer<typeof egressConfigSchema>

/** Thrown when a target resolves to an address the guard refuses. */
export class BlockedEgressError extends Error {
  constructor(host: string, address: string) {
    super(`Refusing to connect to ${host}: ${address} is a private or reserved address`)
    this.name = 'BlockedEgressError'
  }
}

/** True for an IPv4 address in a loopback, private, link-local, or reserved range. */
function isPrivateIpv4(ip: string): boolean {
  const parts = ip.split('.').map((part) => Number(part))

  if (parts.length !== 4 || parts.some((part) => Number.isNaN(part) || part < 0 || part > 255)) {
    return false
  }

  const [a, b] = parts as [number, number, number, number]

  if (a === 0 || a === 10 || a === 127) {
    return true
  }

  if (a === 169 && b === 254) {
    // Link-local, which is where the cloud metadata service (169.254.169.254) lives.
    return true
  }

  if (a === 172 && b >= 16 && b <= 31) {
    return true
  }

  if (a === 192 && b === 168) {
    return true
  }

  if (a === 100 && b >= 64 && b <= 127) {
    // Carrier-grade NAT.
    return true
  }

  // Multicast (224.0.0.0/4) and reserved (240.0.0.0/4), including broadcast.
  return a >= 224
}

/** True for an IPv6 address in a loopback, unspecified, link-local, or unique-local range. */
function isPrivateIpv6(ip: string): boolean {
  const lower = ip.toLowerCase()

  if (lower === '::1' || lower === '::') {
    return true
  }

  const mapped = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/u.exec(lower)

  if (mapped?.[1] !== undefined) {
    // An IPv4 address written in IPv6 form resolves by its IPv4 rules.
    return isPrivateIpv4(mapped[1])
  }

  const firstHextet = Number.parseInt(lower.split(':')[0] || '0', 16)

  // fe80::/10 link-local.
  if ((firstHextet & 0xffc0) === 0xfe80) {
    return true
  }

  // fc00::/7 unique-local.
  return (firstHextet & 0xfe00) === 0xfc00
}

function isPrivateAddress(ip: string): boolean {
  return isIP(ip) === 6 ? isPrivateIpv6(ip) : isPrivateIpv4(ip)
}

export interface EgressGuard {
  /**
   * @throws BlockedEgressError when the URL's host resolves to a private or
   *   reserved address. Resolves normally when the guard is off, or when every
   *   resolved address is public.
   */
  check(url: string): Promise<void>
}

/**
 * Builds the guard. When `BLOCK_PRIVATE_EGRESS` is false the guard is a no-op, so
 * a self-hosted deployment keeps reaching its internal endpoints.
 *
 * @param resolveHost Injected so a test can classify a host without real DNS.
 */
export function createEgressGuard(
  config: EgressConfig,
  resolveHost: (host: string) => Promise<readonly string[]> = defaultResolveHost,
): EgressGuard {
  if (!config.BLOCK_PRIVATE_EGRESS) {
    return { check: () => Promise.resolve() }
  }

  return {
    async check(url) {
      const host = new URL(url).hostname
      // A bracketed IPv6 literal arrives with its brackets; `URL.hostname` keeps
      // them, and `isIP` wants them gone.
      const bareHost = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host
      const addresses = isIP(bareHost) !== 0 ? [bareHost] : await resolveHost(bareHost)

      for (const address of addresses) {
        if (isPrivateAddress(address)) {
          throw new BlockedEgressError(host, address)
        }
      }
    },
  }
}

async function defaultResolveHost(host: string): Promise<readonly string[]> {
  const results = await lookup(host, { all: true })

  return results.map((result) => result.address)
}
