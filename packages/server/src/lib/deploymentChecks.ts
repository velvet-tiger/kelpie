import ipaddr from 'ipaddr.js'

import type { RuntimeMode } from './config.ts'

/**
 * Checks on a deployment's settings that are made once, at boot.
 *
 * `NODE_ENV=development` is correct on a developer's own machine and wrong on
 * a server: the session cookie has no `Secure` flag in that mode, so a browser
 * sends it over plain http. A scaffolded project starts in that mode, and
 * nothing stops an operator who deploys it without a change. The base URL
 * tells the two cases apart: on a developer's machine it names that machine.
 */

/**
 * True when the host name is this machine: `localhost`, a `.localhost` name, or
 * a loopback address. An IPv6 address can be in brackets or not.
 */
export function isLoopbackHost(host: string): boolean {
  const hostname = host.trim().toLowerCase()

  if (hostname === 'localhost' || hostname.endsWith('.localhost')) {
    return true
  }

  // `URL.hostname` keeps the brackets of an IPv6 literal.
  const address = hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname

  return ipaddr.isValid(address) && ipaddr.parse(address).range() === 'loopback'
}

/** True when the URL's host is this machine. */
function isLoopbackUrl(value: string): boolean {
  try {
    return isLoopbackHost(new URL(value).hostname)
  } catch {
    return false
  }
}

/**
 * The warning for a deployment that runs in development mode on an address
 * other people can reach, or `undefined` when there is nothing to say.
 *
 * @param runtimeMode The value of `NODE_ENV`.
 * @param appBaseUrl The value of `APP_BASE_URL`, when one is set.
 */
export function developmentModeWarning(
  runtimeMode: RuntimeMode,
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

/**
 * The warning for a production deployment that uses the `log` email provider,
 * or `undefined` when there is nothing to say.
 *
 * With that provider nobody receives an invitation or a password reset. When
 * the body is written too, each line holds a link that signs a person in, and
 * everybody who can read the log can use it.
 *
 * @param runtimeMode The mode the deployment runs in.
 * @param usesLogProvider Whether `email.provider` picks the built-in log sender.
 * @param writesBody Whether the log sender writes the message body.
 */
export function logEmailProviderWarning(
  runtimeMode: RuntimeMode,
  usesLogProvider: boolean,
  writesBody: boolean,
): string | undefined {
  if (runtimeMode !== 'production' || !usesLogProvider) {
    return undefined
  }

  const notSent =
    'EMAIL_PROVIDER is "log" in production: no email is sent, so nobody receives an invitation or a password reset. '

  return writesBody
    ? `${notSent}EMAIL_LOG_BODY is "true", so each message body is in the log, with its links. ` +
        'Everybody who can read the log can use a link to sign in. Set EMAIL_PROVIDER to a provider that sends.'
    : `${notSent}The log has no message body, so it has no links. ` +
        'Set EMAIL_PROVIDER to a provider that sends, or set EMAIL_LOG_BODY=true to write the body to the log.'
}
