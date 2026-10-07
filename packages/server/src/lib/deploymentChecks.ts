import ipaddr from 'ipaddr.js'

/**
 * Checks on a deployment's settings that are made once, at boot.
 *
 * `NODE_ENV=development` is correct on a developer's own machine and wrong on
 * a server: the session cookie has no `Secure` flag in that mode, so a browser
 * sends it over plain http. A scaffolded project starts in that mode, and
 * nothing stops an operator who deploys it without a change. The base URL
 * tells the two cases apart: on a developer's machine it names that machine.
 */

/** True when the URL's host is this machine: `localhost`, a `.localhost` name, or a loopback address. */
function isLoopbackUrl(value: string): boolean {
  let hostname: string

  try {
    hostname = new URL(value).hostname.toLowerCase()
  } catch {
    return false
  }

  if (hostname === 'localhost' || hostname.endsWith('.localhost')) {
    return true
  }

  // `URL.hostname` keeps the brackets of an IPv6 literal.
  const address = hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname

  return ipaddr.isValid(address) && ipaddr.parse(address).range() === 'loopback'
}

/**
 * The warning for a deployment that runs in development mode on an address
 * other people can reach, or `undefined` when there is nothing to say.
 *
 * @param runtimeMode The value of `NODE_ENV`.
 * @param appBaseUrl The value of `APP_BASE_URL`, when one is set.
 */
export function developmentModeWarning(
  runtimeMode: 'development' | 'test' | 'production',
  appBaseUrl: string | undefined,
): string | undefined {
  if (runtimeMode !== 'development' || appBaseUrl === undefined || isLoopbackUrl(appBaseUrl)) {
    return undefined
  }

  return (
    'NODE_ENV is "development", but APP_BASE_URL is not an address on this machine. ' +
    'In development mode the session cookie has no Secure flag. Set NODE_ENV=production for a deployment.'
  )
}
