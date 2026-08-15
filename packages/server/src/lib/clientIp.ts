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
