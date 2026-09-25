/**
 * Where the OAuth protocol endpoints mount. A leaf file, so `app.ts` (for the
 * rate limit) and `webBundle.ts` (for the page fallback) can name the prefix
 * without importing the module.
 */
export const OAUTH_ROUTE_PREFIX = '/oauth'

/** The discovery documents live here, under RFC 8615's well-known prefix. */
export const WELL_KNOWN_PREFIX = '/.well-known'
