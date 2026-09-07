import { z } from 'zod'

/**
 * Wire shape for `GET /v1/public/config`.
 *
 * A public, credential-free endpoint the browser reads once at boot. It names
 * which runtime the server is in, and the human-readable name of this
 * deployment. The UI uses `runtimeMode` to gate a non-production banner,
 * `siteName` to label it, `signupsEnabled` to show or hide the sign-up form,
 * and `regions` to draw a region switcher on signed-out pages. Nothing here
 * is sensitive: `runtimeMode` is observable from any error message, and the
 * other fields exist to be visible.
 */

export type PublicRuntimeMode = 'development' | 'test' | 'production'

/**
 * One deployable origin a multi-region assembly advertises on the sign-in
 * page. `origin` is the host the browser navigates to; the path and query
 * stay. An empty list (the default) means a single-origin install.
 */
export interface PublicRegion {
  readonly id: string
  readonly label: string
  readonly origin: string
}

export interface PublicConfig {
  readonly runtimeMode: PublicRuntimeMode
  /** Undefined when the assembly did not set `KELPIE_SITE_NAME`. */
  readonly siteName: string | null
  /** False when the instance has closed new-account creation (`SIGNUPS=closed`). */
  readonly signupsEnabled: boolean
  /** Empty when the assembly did not declare regions. Two or more draws a switcher. */
  readonly regions: readonly PublicRegion[]
}

/**
 * True when `value` is an absolute `http:` or `https:` origin, with no path
 * or query. The switcher concatenates this with the current path, so a path
 * on the origin would double up. Written as a pattern rather than `new URL`
 * so this package does not take a DOM lib.
 */
const HTTP_ORIGIN = /^https?:\/\/[^/?#]+$/u

export function isHttpOrigin(value: string): boolean {
  return HTTP_ORIGIN.test(value)
}

export const publicRegionSchema = z.strictObject({
  id: z.string().min(1),
  label: z.string().min(1),
  origin: z.string().refine(isHttpOrigin, { message: 'must be an absolute http or https origin' }),
})

export const publicRegionsSchema = z.array(publicRegionSchema)

export const publicConfigSchema = z
  .strictObject({
    runtime_mode: z.enum(['development', 'test', 'production']),
    site_name: z.string().min(1).nullable(),
    signups_enabled: z.boolean(),
    regions: publicRegionsSchema.optional().default([]),
  })
  .transform(
    (wire): PublicConfig => ({
      runtimeMode: wire.runtime_mode,
      siteName: wire.site_name,
      signupsEnabled: wire.signups_enabled,
      regions: wire.regions,
    }),
  )
