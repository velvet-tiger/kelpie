import { THEME_PREFERENCES } from '@kelpie/schemas'
import type { ListViewPreference, ThemePreference } from '@kelpie/schemas'
import { boolean, jsonb, pgTable, text } from 'drizzle-orm/pg-core'

import { checkOneOf, citext, createdAt, moment, primaryId, updatedAt } from '../../lib/columns.ts'

/**
 * Accounts are global, not workspace rows (roadmap decision 6). Signup creates a
 * user; the first workspace comes from the onboarding wizard.
 *
 * `sessions.active_workspace_id` is deliberately untyped here: adding a foreign
 * key to `workspaces` would make auth depend on workspace, and workspace already
 * depends on auth for `workspace_members.user_id`. The workspace module owns that
 * constraint instead.
 */

export const users = pgTable('users', {
  id: primaryId(),
  email: citext('email').notNull().unique(),
  name: text('name').notNull(),
  passwordHash: text('password_hash').notNull(),
  /** Null until the address is verified, either by confirming a token or by accepting a workspace invite. */
  emailVerifiedAt: moment('email_verified_at'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
})

export const sessions = pgTable('sessions', {
  id: primaryId(),
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  activeWorkspaceId: text('active_workspace_id'),
  tokenHash: text('token_hash').notNull().unique(),
  device: text('device'),
  location: text('location'),
  lastActiveAt: moment('last_active_at').notNull().defaultNow(),
  expiresAt: moment('expires_at').notNull(),
  createdAt: createdAt(),
})

/**
 * Settings that belong to the person rather than to a workspace.
 *
 * A row is written on the first save, not at signup: the endpoint answers with
 * documented defaults until then, so an account created before this table was
 * ever written to needs no backfill.
 */
export const userPreferences = pgTable(
  'user_preferences',
  {
    userId: text('user_id')
      .primaryKey()
      .references(() => users.id, { onDelete: 'cascade' }),
    timezone: text('timezone').notNull(),
    theme: text('theme').$type<ThemePreference>().notNull(),
    emailDigest: boolean('email_digest').notNull(),
    mentionEmails: boolean('mention_emails').notNull(),
    productUpdates: boolean('product_updates').notNull(),
    /**
     * Per-list column choices, keyed on a stable view id (`people`, `deals`, …).
     * A view id the client no longer recognises stays untouched here rather than
     * being cleaned up: the map is small, and the write path is the client
     * merging its current choice into what it read.
     */
    listViews: jsonb('list_views')
      .$type<Readonly<Record<string, ListViewPreference>>>()
      .notNull()
      .default({}),
    updatedAt: updatedAt(),
  },
  (table) => [checkOneOf('user_preferences_theme_check', table.theme, THEME_PREFERENCES)],
)

/**
 * One-shot tokens for the reset link. Stored hashed like a session token, and
 * marked used rather than deleted so a replayed link is refused rather than
 * treated as an unknown token.
 */
export const passwordResetTokens = pgTable('password_reset_tokens', {
  id: primaryId(),
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  tokenHash: text('token_hash').notNull().unique(),
  expiresAt: moment('expires_at').notNull(),
  usedAt: moment('used_at'),
  createdAt: createdAt(),
})

/**
 * One-shot tokens for the sign-up verification link. Same shape and the same
 * reasoning as `passwordResetTokens`: hashed, marked used rather than deleted.
 */
export const emailVerificationTokens = pgTable('email_verification_tokens', {
  id: primaryId(),
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  tokenHash: text('token_hash').notNull().unique(),
  expiresAt: moment('expires_at').notNull(),
  usedAt: moment('used_at'),
  createdAt: createdAt(),
})
