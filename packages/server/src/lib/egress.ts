import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import type { LookupFunction } from 'node:net'
import ipaddr from 'ipaddr.js'
import { Agent, fetch as pinnedFetch } from 'undici'
import { z } from 'zod'

/**
 * An optional guard against outbound requests to private or reserved addresses.
 *
 * Webhook and agent endpoints are customer-supplied, and a self-hosted Kelpie
 * legitimately posts to an internal host such as `http://automation.internal`.
 * So the guard is off by default (`lib/url.ts` says the same). A hosted
 * deployment, where a customer must not be able to aim a delivery at the
 * metadata service or a neighbour's database, sets `BLOCK_PRIVATE_EGRESS=true`.
 *
 * The guard has two parts. `check` resolves the host and refuses the URL when
 * any resolved address is not a public one. `fetch` makes the request, and
 * its connection resolves the host through the same rule: the socket connects
 * only to an address that the rule accepted in that same lookup. A host whose
 * DNS answer changes between `check` and the connection (DNS rebinding) is
 * thus refused at the connection. A sender must use the guard's `fetch`, not
 * the global one.
 *
 * The senders also pass `redirect: 'manual'`, which closes the redirect-based
 * bypass, and a hosted deployment pairs this with network-level egress rules.
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

/**
 * True when a request may go to this address: a global unicast address and
 * nothing else. The ranges are those of `ipaddr.js`, so loopback, private,
 * link-local, carrier-grade NAT, benchmarking, multicast and reserved
 * addresses are all refused.
 *
 * Each IPv6 form that carries an IPv4 address is refused or reduced to that
 * IPv4 address, because the request ends at the IPv4 host: IPv4-mapped
 * (`::ffff:a.b.c.d`) is classified by its IPv4 address; NAT64
 * (`64:ff9b::/96`), 6to4 (`2002::/16`), Teredo and IPv4-compatible
 * (`::a.b.c.d`) are refused. A string that is not an address is refused.
 */
function isPublicAddress(ip: string): boolean {
  if (!ipaddr.isValid(ip)) {
    return false
  }

  const parsed = ipaddr.parse(ip)

  if (parsed.kind() === 'ipv4') {
    return parsed.range() === 'unicast'
  }

  const ipv6 = parsed as ipaddr.IPv6

  if (ipv6.isIPv4MappedAddress()) {
    return ipv6.toIPv4Address().range() === 'unicast'
  }

  // `::/96`: the unspecified address, loopback, and the IPv4-compatible form.
  if (ipv6.parts.slice(0, 6).every((part) => part === 0)) {
    return false
  }

  return ipv6.range() === 'unicast'
}

/** `URL.hostname` keeps the brackets of an IPv6 literal; `isIP` wants them gone. */
function bareHostOf(url: string): string {
  const host = new URL(url).hostname

  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host
}

/** The `BlockedEgressError` in an error's `cause` chain, when there is one. */
function blockedCauseOf(error: unknown): BlockedEgressError | undefined {
  for (let current = error, depth = 0; current instanceof Error && depth < 5; current = current.cause, depth += 1) {
    if (current instanceof BlockedEgressError) {
      return current
    }

    if (current instanceof AggregateError) {
      const blocked = current.errors.find((inner) => inner instanceof BlockedEgressError)

      if (blocked instanceof BlockedEgressError) {
        return blocked
      }
    }
  }

  return undefined
}

type ResolveHost = (host: string) => Promise<readonly string[]>

/**
 * A `lookup` for a socket, in the shape `net.connect` takes. It gives the
 * socket only addresses the guard accepts, and fails when the host has one
 * that it does not. The socket connects to what this lookup returned, so no
 * second DNS answer can change the target.
 */
function createGuardedLookup(resolveHost: ResolveHost): LookupFunction {
  return (hostname, options, callback) => {
    resolveHost(hostname).then(
      (addresses) => {
        const refused = addresses.find((address) => !isPublicAddress(address))
        const [first] = addresses

        if (refused !== undefined) {
          callback(new BlockedEgressError(hostname, refused), [])
        } else if (first === undefined) {
          callback(new Error(`${hostname} has no address`), [])
        } else if (options.all === true) {
          callback(
            null,
            addresses.map((address) => ({ address, family: isIP(address) })),
          )
        } else {
          callback(null, first, isIP(first))
        }
      },
      (error: unknown) => {
        callback(error instanceof Error ? error : new Error(String(error)), [])
      },
    )
  }
}

export interface EgressGuard {
  /**
   * @throws BlockedEgressError when the URL's host resolves to a private or
   *   reserved address. Resolves normally when the guard is off, or when every
   *   resolved address is public.
   */
  check(url: string): Promise<void>
  /**
   * The `fetch` for a request to a customer-supplied URL. With the guard on,
   * the connection goes only to an address the guard accepted, and the
   * request rejects with a `BlockedEgressError` when the host has an address
   * that it did not. With the guard off, it is the global `fetch`.
   */
  readonly fetch: typeof fetch
}

/**
 * Builds the guard. When `BLOCK_PRIVATE_EGRESS` is false the guard is a no-op, so
 * a self-hosted deployment keeps reaching its internal endpoints.
 *
 * @param resolveHost Injected so a test can classify a host without real DNS.
 */
export function createEgressGuard(
  config: EgressConfig,
  resolveHost: ResolveHost = defaultResolveHost,
): EgressGuard {
  if (!config.BLOCK_PRIVATE_EGRESS) {
    return { check: () => Promise.resolve(), fetch: (input, init) => fetch(input, init) }
  }

  const dispatcher = new Agent({ connect: { lookup: createGuardedLookup(resolveHost) } })

  return {
    async check(url) {
      const host = bareHostOf(url)
      const addresses = isIP(host) !== 0 ? [host] : await resolveHost(host)

      for (const address of addresses) {
        if (!isPublicAddress(address)) {
          throw new BlockedEgressError(host, address)
        }
      }
    },
    fetch(input, init) {
      const url = input instanceof Request ? input.url : String(input)
      const host = bareHostOf(url)

      // A socket to a literal address does no lookup, so the literal is
      // checked here. A hostname is checked by the connection's own lookup.
      if (isIP(host) !== 0 && !isPublicAddress(host)) {
        return Promise.reject(new BlockedEgressError(host, host))
      }

      // `undici` has its own request and response types. They are the same
      // Fetch Standard shapes as the global ones; only the declarations differ.
      const request = pinnedFetch as unknown as (
        input: Parameters<typeof fetch>[0],
        init: object,
      ) => Promise<Response>

      return request(input, { ...init, dispatcher }).catch((error: unknown) => {
        // `fetch` rejects with a `TypeError` whose cause is the socket's
        // error. The caller records the reason, so it gets the guard's own.
        throw blockedCauseOf(error) ?? error
      })
    },
  }
}

async function defaultResolveHost(host: string): Promise<readonly string[]> {
  const results = await lookup(host, { all: true })

  return results.map((result) => result.address)
}
