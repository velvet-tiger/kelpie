import { z } from 'zod'

import { THEME_PREFERENCES } from './values.ts'
import type { ThemePreference } from './values.ts'
import { definedFields, idSchema, timestampSchema } from './wire.ts'

/**
 * Wire shapes for `/v1/account`: the signed-in human, rather than the workspace
 * they are looking at or the session they arrived on.
 *
 * An account is global. Changing a name here changes it in every workspace the
 * person belongs to, which is why this is not part of the member resource.
 */

export interface Account {
  readonly id: string
  readonly email: string
  readonly name: string
  readonly emailVerified: boolean
}

export const accountSchema: z.ZodType<Account, unknown> = z
  .object({
    id: idSchema,
    email: z.string(),
    name: z.string(),
    email_verified: z.boolean(),
  })
  .transform(
    (wire): Account => ({
      id: wire.id,
      email: wire.email,
      name: wire.name,
      emailVerified: wire.email_verified,
    }),
  )

export interface UpdateAccountInput {
  readonly name?: string
  readonly email?: string
  /** Required by the service whenever `email` is present. */
  readonly currentPassword?: string
}

export function updateAccountBody(input: UpdateAccountInput): Record<string, unknown> {
  return definedFields({
    name: input.name,
    email: input.email,
    current_password: input.currentPassword,
  })
}

/**
 * One of the caller's sessions, as the Security page lists them.
 *
 * Distinct from `Session` in `session.ts`, which is the single identity behind
 * `GET /v1/auth/me`. This is a row in "where am I signed in", and `current`
 * marks the one asking.
 *
 * `device` and `location` are nullable because the service records what the
 * request actually carried. A `User-Agent` is usually present; nothing derives
 * a location today, so it is always `null`.
 */
export interface AccountSession {
  readonly id: string
  readonly device: string | null
  readonly location: string | null
  readonly lastActiveAt: Date
  readonly current: boolean
}

export const accountSessionSchema: z.ZodType<AccountSession, unknown> = z
  .object({
    id: idSchema,
    device: z.string().nullable(),
    location: z.string().nullable(),
    last_active_at: timestampSchema,
    current: z.boolean(),
  })
  .transform(
    (wire): AccountSession => ({
      id: wire.id,
      device: wire.device,
      location: wire.location,
      lastActiveAt: wire.last_active_at,
      current: wire.current,
    }),
  )

/**
 * The shortest password the service will hash.
 *
 * Part of the contract rather than a server detail: signup, reset, and the
 * change-password form all have to state the rule before a caller submits, and
 * a second copy in the browser is a copy that can drift below the real one.
 */
export const MINIMUM_PASSWORD_LENGTH = 12

export interface ChangePasswordInput {
  readonly currentPassword: string
  readonly newPassword: string
}

export function changePasswordBody(input: ChangePasswordInput): Record<string, unknown> {
  return { current_password: input.currentPassword, new_password: input.newPassword }
}

/**
 * Per-account settings that follow the person between browsers.
 *
 * The three notification fields are stored choices, not switches over a running
 * mailer: Kelpie sends no digest, mention, or product email yet. They record
 * what to do when it does, and the Preferences page says so on screen rather
 * than leaving a reader to infer a capability from a toggle.
 */
export interface AccountPreferences {
  readonly timezone: string
  readonly theme: ThemePreference
  readonly emailDigest: boolean
  readonly mentionEmails: boolean
  readonly productUpdates: boolean
}

export const accountPreferencesSchema: z.ZodType<AccountPreferences, unknown> = z
  .object({
    timezone: z.string(),
    theme: z.enum(THEME_PREFERENCES),
    email_digest: z.boolean(),
    mention_emails: z.boolean(),
    product_updates: z.boolean(),
  })
  .transform(
    (wire): AccountPreferences => ({
      timezone: wire.timezone,
      theme: wire.theme,
      emailDigest: wire.email_digest,
      mentionEmails: wire.mention_emails,
      productUpdates: wire.product_updates,
    }),
  )

export interface UpdateAccountPreferencesInput {
  readonly timezone?: string
  readonly theme?: ThemePreference
  readonly emailDigest?: boolean
  readonly mentionEmails?: boolean
  readonly productUpdates?: boolean
}

export function updateAccountPreferencesBody(
  input: UpdateAccountPreferencesInput,
): Record<string, unknown> {
  return definedFields({
    timezone: input.timezone,
    theme: input.theme,
    email_digest: input.emailDigest,
    mention_emails: input.mentionEmails,
    product_updates: input.productUpdates,
  })
}
