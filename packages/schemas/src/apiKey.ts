import { z } from 'zod'

import { API_KEY_KINDS } from './values.ts'
import type { ApiKeyKind } from './values.ts'
import { idSchema, nullableTimestampSchema, timestampSchema } from './wire.ts'

/**
 * Wire shapes for `/v1/api-keys`.
 *
 * The secret appears exactly once, in the `201` that creates the key, and never
 * again — the same contract webhook signing secrets have. Every later read
 * carries only `display_prefix`, which is enough to tell two keys apart in a
 * list and useless to anyone who intercepts it.
 */

export interface ApiKey {
  readonly id: string
  readonly name: string
  readonly kind: ApiKeyKind
  /** The prefix plus the last four characters, e.g. `kp_live_…9f2c`. */
  readonly displayPrefix: string
  readonly lastUsedAt: Date | null
  readonly createdAt: Date
}

/** The one response that ever carries the secret. Nothing can retrieve it later. */
export interface CreatedApiKey extends ApiKey {
  readonly secret: string
}

const apiKeyWire = {
  id: idSchema,
  name: z.string(),
  kind: z.enum(API_KEY_KINDS),
  display_prefix: z.string(),
  last_used_at: nullableTimestampSchema,
  created_at: timestampSchema,
}

const apiKeyWireSchema = z.object(apiKeyWire)

function toApiKey(wire: z.output<typeof apiKeyWireSchema>): ApiKey {
  return {
    id: wire.id,
    name: wire.name,
    kind: wire.kind,
    displayPrefix: wire.display_prefix,
    lastUsedAt: wire.last_used_at,
    createdAt: wire.created_at,
  }
}

export const apiKeySchema: z.ZodType<ApiKey, unknown> = apiKeyWireSchema.transform(toApiKey)

export const createdApiKeySchema: z.ZodType<CreatedApiKey, unknown> = z
  .object({ ...apiKeyWire, secret: z.string() })
  .transform((wire): CreatedApiKey => ({ ...toApiKey(wire), secret: wire.secret }))

export interface CreateApiKeyInput {
  readonly name: string
  readonly kind: ApiKeyKind
}

export function createApiKeyBody(input: CreateApiKeyInput): unknown {
  return { name: input.name, kind: input.kind }
}
