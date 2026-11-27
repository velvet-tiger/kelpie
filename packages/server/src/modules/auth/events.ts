import { z } from 'zod'

import type { ModuleEventCatalog } from '../../runtime/module.ts'

/**
 * Account lifecycle events published by the auth module.
 *
 * An account is global, so these are account events (`KelpieAccountEvents`):
 * the envelope carries `workspaceId: null` and the target is the account
 * (`user`). The actor is the account itself, except on an operator's
 * deletion (below).
 *
 * `auth.user.created` fires when a sign-up commits a new account: a password
 * sign-up, or an external sign-in that provisioned one. Signing in to an
 * account that already exists does not fire it.
 *
 * `auth.user.email_changed` fires when the account's sign-in address changes.
 * Saving the address already on file is not a change and fires nothing.
 *
 * `auth.user.email_verified` fires when the address is proved to belong to the
 * account: the owner follows a verification link, accepts a workspace invitation,
 * or an external sign-in links an account whose address was never confirmed. It
 * fires only when that changes the account, so a repeat confirmation fires nothing.
 *
 * `auth.user.deleted` fires when an account is deleted: by the account
 * itself, or by an operator. The actor says which: the account for the first,
 * `system` for the second. The row is gone by the time a subscriber hears of
 * it, so the event is the last place the address can be read.
 *
 * All four carry the address, because a subscriber that keeps a directory of
 * accounts (the cloud's account router) keys it on the address. Webhooks never
 * deliver them: an account event belongs to no workspace.
 *
 * `emailVerified` says whether anyone has proved control of that address yet.
 * A password sign-up and an email change carry `false`. The owner confirms
 * through the verification email afterwards, which fires
 * `auth.user.email_verified`. An external sign-up carries `true`, because the
 * provider proved it. A subscriber that must not let an unproved address claim
 * anything treats a `false` entry as provisional until that event arrives.
 */

export const authEvents = {
  'auth.user.created': z.object({
    userId: z.string(),
    email: z.string(),
    emailVerified: z.boolean(),
    method: z.enum(['password', 'external']),
    verifiedBy: z.string().nullable(),
  }),
  'auth.user.email_changed': z.object({
    userId: z.string(),
    previousEmail: z.string(),
    email: z.string(),
    emailVerified: z.literal(false),
  }),
  'auth.user.email_verified': z.object({
    userId: z.string(),
    email: z.string(),
  }),
  'auth.user.deleted': z.object({
    userId: z.string(),
    email: z.string(),
  }),
} satisfies ModuleEventCatalog

export interface UserCreatedData {
  readonly userId: string
  /** Normalised: trimmed and lowercase. */
  readonly email: string
  /** False for a password sign-up, whose owner has not confirmed the address yet. True for an external one. */
  readonly emailVerified: boolean
  readonly method: 'password' | 'external'
  /** The module that verified an external sign-up (`sign-in:google`). Null for a password one. */
  readonly verifiedBy: string | null
}

export interface UserEmailChangedData {
  readonly userId: string
  readonly previousEmail: string
  /** The new address, normalised. */
  readonly email: string
  /** Always false: core resets verification on a change, and the owner confirms it later. */
  readonly emailVerified: false
}

export interface UserEmailVerifiedData {
  readonly userId: string
  /** Normalised. The address the account proved it controls. */
  readonly email: string
}

export interface UserDeletedData {
  readonly userId: string
  /** The address the account had when it was deleted, normalised. */
  readonly email: string
}

declare module '../../runtime/events.ts' {
  interface KelpieEventMap {
    'auth.user.created': UserCreatedData
    'auth.user.email_changed': UserEmailChangedData
    'auth.user.email_verified': UserEmailVerifiedData
    'auth.user.deleted': UserDeletedData
  }

  interface KelpieAccountEvents {
    'auth.user.created': true
    'auth.user.email_changed': true
    'auth.user.email_verified': true
    'auth.user.deleted': true
  }
}
