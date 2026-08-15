import { z } from 'zod'

/**
 * The deployment's own base URL, and how token links in transactional mail are
 * built from it.
 *
 * The service builds every reset, verification, and invite link itself, from a
 * configured base URL. It does not build them from a URL the caller sends. A
 * caller-supplied link lets anyone point a real Kelpie email at any address,
 * which is an account-takeover path. The base URL is set once per deployment,
 * beside the database URL and the mail provider.
 */

const APP_BASE_URL_MESSAGE = 'must be an absolute http:// or https:// URL, e.g. https://crm.example.com'

/** True when the value is an absolute http(s) URL with no embedded credentials. */
function isValidBaseUrl(value: string): boolean {
  let url: URL

  try {
    url = new URL(value)
  } catch {
    return false
  }

  const protocolAllowed = url.protocol === 'http:' || url.protocol === 'https:'

  return protocolAllowed && url.username.length === 0 && url.password.length === 0
}

/** The one variable the auth and workspace modules read to build their links. */
export const appUrlConfigSchema = z.object({
  APP_BASE_URL: z.string().refine(isValidBaseUrl, { message: APP_BASE_URL_MESSAGE }),
})

export type AppUrlConfig = z.infer<typeof appUrlConfigSchema>

/**
 * The browser app's routes for each token-carrying link. They match the paths
 * the single-page app serves (`packages/ui`), so a link built here reaches a
 * real page once that bundle is deployed at `APP_BASE_URL`.
 */
export const APP_LINK_PATHS = {
  passwordReset: '/reset-password',
  verifyEmail: '/verify-email',
  inviteAccept: '/join',
} as const

/**
 * Builds a link at the deployment's base URL, carrying the token as a query
 * parameter.
 *
 * `new URL(path, baseUrl)` resolves the path against the base, so a base with a
 * trailing slash and one without give the same result. The token is base64url
 * and needs no escaping. `searchParams` encodes it regardless, rather than trust
 * that.
 */
export function buildAppLink(baseUrl: string, path: string, token: string): string {
  const url = new URL(path, baseUrl)

  url.searchParams.set('token', token)

  return url.toString()
}
