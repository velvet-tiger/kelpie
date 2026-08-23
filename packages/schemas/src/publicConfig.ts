import { z } from 'zod'

/**
 * Wire shape for `GET /v1/public/config`.
 *
 * A public, credential-free endpoint the browser reads once at boot. It names
 * which runtime the server is in, and the human-readable name of this
 * deployment. The UI uses `runtimeMode` to gate a non-production banner and
 * `siteName` to label it. Nothing here is sensitive: `runtimeMode` is
 * observable from any error message, and `siteName` exists to be visible.
 */

export type PublicRuntimeMode = 'development' | 'test' | 'production'

export interface PublicConfig {
  readonly runtimeMode: PublicRuntimeMode
  /** Undefined when the assembly did not set `KELPIE_SITE_NAME`. */
  readonly siteName: string | null
}

export const publicConfigSchema = z
  .strictObject({
    runtime_mode: z.enum(['development', 'test', 'production']),
    site_name: z.string().min(1).nullable(),
  })
  .transform(
    (wire): PublicConfig => ({
      runtimeMode: wire.runtime_mode,
      siteName: wire.site_name,
    }),
  )
