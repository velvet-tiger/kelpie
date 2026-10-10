import ipaddr from 'ipaddr.js'

/**
 * Resolving the caller's IP when the service sits behind trusted proxies.
 *
 * The rate limiter keys on this, so trusting it wrongly matters both ways: read a
 * forgeable header and an attacker rotates it to dodge the limit; ignore a real
 * proxy and every caller collapses into one bucket behind the load balancer.
 *
 * The deployment states how many proxies stand in front of it
 * (`TRUSTED_PROXY_HOP_COUNT`). Zero, the default, means the service is reached
 * directly and the socket address is the client. A positive count means the last
 * N entries of `X-Forwarded-For` were written by infrastructure this deployment
 * controls, so the entry just left of them is the client as the outermost trusted
 * proxy saw it, which no earlier hop could forge.
 */

/**
 * @param socketAddress The address the TCP connection arrived from.
 * @param forwardedFor The raw `X-Forwarded-For` header, or undefined.
 * @param hopCount How many trusted proxies stand in front of the service.
 * @returns The client's IP. Falls back to the socket address whenever the header
 *   is absent or holds fewer entries than the configured hop count, so a
 *   misconfiguration over-limits rather than trusts a forgeable position.
 */
export function resolveClientIpFrom(
  socketAddress: string,
  forwardedFor: string | undefined,
  hopCount: number,
): string {
  if (hopCount <= 0 || forwardedFor === undefined) {
    return socketAddress
  }

  const entries = forwardedFor
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)

  const index = entries.length - hopCount

  return index >= 0 ? (entries[index] ?? socketAddress) : socketAddress
}

/** How many 16-bit groups of an IPv6 address make up the `/64` network prefix. */
const IPV6_NETWORK_GROUPS = 4

/**
 * The key the rate limiter counts a client address under.
 *
 * An IPv6 client is counted by its `/64` prefix. A provider gives one customer
 * at least a whole `/64`, so a caller can pick a new address in it for every
 * request, and a counter per full address would never fill.
 *
 * An IPv4 address is its own key. An IPv4-mapped IPv6 address
 * (`::ffff:a.b.c.d`) is the same host as that IPv4 address, and a dual-stack
 * socket reports it in that form, so it is reduced to the IPv4 address.
 *
 * @param address The client address from `resolveClientIpFrom`.
 * @returns The key. A value that is not an IP address is returned unchanged:
 *   all such callers still share one counter, which over-limits rather than
 *   under-limits.
 */
export function rateLimitKeyForIp(address: string): string {
  if (!ipaddr.isValid(address)) {
    return address
  }

  const parsed = ipaddr.parse(address)

  if (parsed.kind() === 'ipv4') {
    return parsed.toString()
  }

  const ipv6 = parsed as ipaddr.IPv6

  if (ipv6.isIPv4MappedAddress()) {
    return ipv6.toIPv4Address().toString()
  }

  const prefix = ipv6.parts
    .slice(0, IPV6_NETWORK_GROUPS)
    .map((group) => group.toString(16))
    .join(':')

  return `${prefix}::/64`
}
