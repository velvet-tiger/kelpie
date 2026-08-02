import { boolean, pgTable, text } from 'drizzle-orm/pg-core'

import { citext, createdAt, moment, primaryId, updatedAt } from '../../lib/columns.ts'

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

export const userPreferences = pgTable('user_preferences', {
  userId: text('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  timezone: text('timezone').notNull(),
  theme: text('theme').notNull(),
  emailDigest: boolean('email_digest').notNull(),
  mentionEmails: boolean('mention_emails').notNull(),
  productUpdates: boolean('product_updates').notNull(),
  updatedAt: updatedAt(),
})

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
