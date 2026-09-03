import { APP_LINK_PATHS, buildAppLink } from '../../lib/appUrl.ts'
import type { EmailSender } from '../../lib/email.ts'
import { renderEmail } from '../../lib/emailContent.ts'
import { AppError, ExternalSignInError } from '../../lib/errors.ts'
import type { IdFactory } from '../../lib/ids.ts'
import { UNIQUE_VIOLATION, postgresErrorCode } from '../../lib/database.ts'
import type { Database } from '../../lib/database.ts'
import { MINIMUM_PASSWORD_LENGTH, hashPassword, verifyPassword } from '../../lib/passwords.ts'
import { generateToken, hashToken } from '../../lib/tokens.ts'
import type { VerifiedIdentity } from '../../runtime/module.ts'
import type { TransactionScope } from '../../runtime/transaction.ts'
import type { SessionActor } from './actor.ts'
import { DEFAULT_PREFERENCES, applyPreferenceChanges } from './preferences.ts'
import type { PreferenceChanges, PreferenceValues } from './preferences.ts'
import * as repository from './repository.ts'

/**
 * Account and session rules.
 *
 * Two principles run through this file. Anything a stranger can call must not
 * reveal whether an email is registered, so login and reset-request behave the
 * same either way. And any change of password ends every other session, because
 * the usual reason to change one is that it leaked.
 */

const SESSION_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000
const RESET_TOKEN_LIFETIME_MS = 60 * 60 * 1000
/** Longer than a reset token: there is no stolen-account urgency, and an inbox is checked on its own time. */
const EMAIL_VERIFICATION_TOKEN_LIFETIME_MS = 24 * 60 * 60 * 1000

export interface AuthDependencies {
  readonly db: Database
  readonly transaction: TransactionScope
  readonly email: EmailSender
  readonly createId: IdFactory
  readonly now: () => Date
  /** The deployment's own base URL. Every emailed link is built from it. */
  readonly appBaseUrl: string
  /** Injected only so tests can pin tokens. Production uses the crypto default. */
  readonly newToken?: () => string
}

export interface AccountView {
  readonly id: string
  readonly email: string
  readonly name: string
  readonly emailVerified: boolean
}

/** A session plus the plaintext token, which exists only in this return value. */
export interface IssuedSession {
  readonly account: AccountView
  readonly sessionToken: string
  readonly expiresAt: Date
  readonly activeWorkspaceId: string | null
}

/** What `completeExternalSignIn` returns: an issued session plus whether it made the account. */
export interface ExternalIssuedSession extends IssuedSession {
  readonly created: boolean
}

export interface SessionView {
  readonly id: string
  readonly device: string | null
  readonly location: string | null
  readonly lastActiveAt: Date
  readonly current: boolean
  /** The module that signed this session in, or null for a password sign-in. */
  readonly signedInVia: string | null
}

export interface SignUpInput {
  readonly email: string
  readonly name: string
  readonly password: string
  readonly device?: string
  readonly location?: string
}

/** Only what the caller sent. An absent field is left alone, per `api.md`. */
export interface UpdateAccountChanges {
  readonly name?: string
  readonly email?: string
  /** Required, and verified, whenever `email` is present. */
  readonly currentPassword?: string
}

export interface LogInInput {
  readonly email: string
  readonly password: string
  readonly device?: string
  readonly location?: string
}

/** A `VerifiedIdentity` plus what the request itself says about the client. */
export interface ExternalSignInInput extends VerifiedIdentity {
  readonly device?: string
  readonly location?: string
}

function toAccountView(user: repository.UserRecord): AccountView {
  return { id: user.id, email: user.email, name: user.name, emailVerified: user.emailVerifiedAt !== null }
}

function toPreferenceValues(record: repository.UserPreferencesRecord): PreferenceValues {
  return {
    timezone: record.timezone,
    theme: record.theme,
    emailDigest: record.emailDigest,
    mentionEmails: record.mentionEmails,
    productUpdates: record.productUpdates,
    listViews: record.listViews,
  }
}

/** Emails are stored and compared lowercase, per `schema.md`. */
function normaliseEmail(email: string): string {
  return email.trim().toLowerCase()
}

/**
 * The name to use when a provider sends none. `users.name` is not nullable and
 * an address is the only other thing an identity is guaranteed to carry.
 */
function localPartOf(email: string): string {
  const [local] = email.split('@')

  return local === undefined || local.length === 0 ? email : local
}

/**
 * Rejects a field that is only whitespace.
 *
 * The route already refuses an empty string, but `"   "` passes that and then
 * normalises to nothing. Storing a nameless account or an empty address would be
 * accepting a request the caller did not mean to make.
 */
function requireText(value: string, field: string): string {
  const trimmed = value.trim()

  if (trimmed.length === 0) {
    throw AppError.validationFailed(`${field} cannot be blank`, [
      { field, message: 'Cannot be blank' },
    ])
  }

  return trimmed
}

export interface AuthService {
  /** Creates the account only. The first workspace comes from onboarding. */
  signUp(input: SignUpInput): Promise<IssuedSession>
  logIn(input: LogInInput): Promise<IssuedSession>
  /**
   * Signs in an identity a module verified elsewhere, provisioning the account
   * when the module asked for it. Never sends a verification email: the
   * provider already proved control of the address.
   */
  completeExternalSignIn(input: ExternalSignInInput): Promise<ExternalIssuedSession>
  logOut(actor: SessionActor): Promise<void>
  getAccount(actor: SessionActor): Promise<AccountView>
  updateAccount(actor: SessionActor, changes: UpdateAccountChanges): Promise<AccountView>
  /** Answers documented defaults for an account that has never saved any. */
  getPreferences(actor: SessionActor): Promise<PreferenceValues>
  updatePreferences(actor: SessionActor, changes: PreferenceChanges): Promise<PreferenceValues>
  listSessions(actor: SessionActor): Promise<readonly SessionView[]>
  revokeSession(actor: SessionActor, sessionId: string): Promise<void>
  /** Resolves whether or not the address is registered. */
  requestPasswordReset(email: string): Promise<void>
  confirmPasswordReset(token: string, newPassword: string): Promise<void>
  changePassword(actor: SessionActor, currentPassword: string, newPassword: string): Promise<void>
  /** Issues a fresh verification token and emails it. A no-op once already verified. */
  requestEmailVerification(actor: SessionActor): Promise<void>
  confirmEmailVerification(token: string): Promise<void>
}

export function createAuthService(dependencies: AuthDependencies): AuthService {
  const newToken = dependencies.newToken ?? generateToken

  /**
   * The account behind a live session. A session outliving its user means the
   * row was deleted underneath it, which is not an authenticated caller.
   */
  async function requireUser(userId: string): Promise<repository.UserRecord> {
    const user = await repository.findUserById(dependencies.db, userId)

    if (user === undefined) {
      throw AppError.unauthorized('This session no longer belongs to an account')
    }

    return user
  }

  async function issueSession(
    db: repository.Queryable,
    user: repository.UserRecord,
    device: string | undefined,
    location: string | undefined,
    /** The module that verified the identity, or null for a password sign-in. */
    signedInVia: string | null = null,
  ): Promise<IssuedSession> {
    const now = dependencies.now()
    const token = newToken()
    const expiresAt = new Date(now.getTime() + SESSION_LIFETIME_MS)
    const membership = await repository.findFirstMembership(db, user.id)

    await repository.insertSession(db, {
      id: dependencies.createId('session'),
      userId: user.id,
      activeWorkspaceId: membership?.workspaceId ?? null,
      tokenHash: hashToken(token),
      device: device ?? null,
      location: location ?? null,
      signedInVia,
      lastActiveAt: now,
      expiresAt,
    })

    return {
      account: toAccountView(user),
      sessionToken: token,
      expiresAt,
      activeWorkspaceId: membership?.workspaceId ?? null,
    }
  }

  function sendVerificationEmail(to: string, token: string): Promise<void> {
    const link = buildAppLink(dependencies.appBaseUrl, APP_LINK_PATHS.verifyEmail, token)
    const { text, html } = renderEmail(
      {
        action: {
          instructions: 'Confirm this address to finish setting up your account:',
          buttonText: 'Verify email address',
          link,
        },
        outro: 'The link expires in 24 hours.',
      },
      dependencies.appBaseUrl,
    )

    return dependencies.email.send({
      to,
      subject: 'Verify your Kelpie email address',
      body: text,
      html,
    })
  }

  return {
    /** Creates the account only. The first workspace comes from onboarding. */
    async signUp(input: SignUpInput): Promise<IssuedSession> {
      if (input.password.length < MINIMUM_PASSWORD_LENGTH) {
        throw AppError.validationFailed('Password is too short', [
          { field: 'password', message: `Must be at least ${MINIMUM_PASSWORD_LENGTH} characters` },
        ])
      }

      const email = normaliseEmail(input.email)
      const passwordHash = await hashPassword(input.password)
      const now = dependencies.now()
      const verificationToken = newToken()

      const issued = await dependencies.transaction(async ({ tx }) => {
        let user: repository.UserRecord

        try {
          user = await repository.insertUser(tx, {
            id: dependencies.createId('user'),
            email,
            name: input.name,
            passwordHash,
          })
        } catch (error: unknown) {
          if (postgresErrorCode(error) === UNIQUE_VIOLATION) {
            // Signup is the one place the address is already known to the caller,
            // so saying so is not a disclosure.
            throw AppError.conflict('An account with that email already exists', [
              { field: 'email', message: 'Already registered' },
            ])
          }

          throw error
        }

        await repository.insertEmailVerificationToken(tx, {
          id: dependencies.createId('emailVerificationToken'),
          userId: user.id,
          tokenHash: hashToken(verificationToken),
          expiresAt: new Date(now.getTime() + EMAIL_VERIFICATION_TOKEN_LIFETIME_MS),
        })

        return issueSession(tx, user, input.device, input.location)
      })

      // Sent after commit, so a rolled-back signup never emails a token.
      await sendVerificationEmail(email, verificationToken)

      return issued
    },

    async logIn(input: LogInInput): Promise<IssuedSession> {
      const user = await repository.findUserByEmail(dependencies.db, normaliseEmail(input.email))

      // Hash a throwaway password when the account is unknown or has no
      // password, so all three cases take the same time to answer.
      const storedHash = user?.passwordHash ?? (await hashPassword('not-a-real-password-placeholder'))
      // Always run the verify, even when the hash is the placeholder: skipping
      // it would make a passwordless account answer faster than a wrong one.
      const matches = await verifyPassword(storedHash, input.password)

      // The null check is the guard, not the placeholder hash. Without it,
      // whoever guessed the placeholder string would sign in to every account
      // that has no password.
      if (user === undefined || user.passwordHash === null || !matches) {
        throw AppError.unauthorized('Email or password is incorrect')
      }

      return dependencies.transaction(({ tx }) => issueSession(tx, user, input.device, input.location))
    },

    /**
     * Signs in an identity a module already verified.
     *
     * Core does not redo the verification and never learns the protocol. What
     * it owns is everything downstream: finding or provisioning the account,
     * issuing the session, and recording which module vouched for it.
     */
    async completeExternalSignIn(input: ExternalSignInInput): Promise<ExternalIssuedSession> {
      // An unverified address is not an identity. A provider that does not say
      // it checked is treated as not having checked.
      if (!input.emailVerified) {
        throw new ExternalSignInError('email_unverified')
      }

      const email = requireText(normaliseEmail(input.email), 'email')
      const name = requireText(input.name ?? localPartOf(email), 'name')
      const now = dependencies.now()

      const link = async (
        tx: repository.Queryable,
        user: repository.UserRecord,
      ): Promise<ExternalIssuedSession> => {
        // Signing in through a provider on an account whose address was never
        // confirmed is the pre-registration takeover case: somebody registered
        // this address with a password and never proved they own it. The
        // provider just proved the opposite. Drop that password and every
        // session it opened; the real owner sets a new one through a reset.
        if (user.emailVerifiedAt === null) {
          await repository.updateUserPassword(tx, user.id, null, now)
          await repository.deleteAllSessionsForUser(tx, user.id)
        }

        // The provider proved control of the address, which is the same thing
        // accepting an invite proves.
        await repository.markEmailVerified(tx, user.id, now)

        const issued = await issueSession(
          tx,
          { ...user, emailVerifiedAt: user.emailVerifiedAt ?? now },
          input.device,
          input.location,
          input.verifiedBy,
        )

        return { ...issued, created: false }
      }

      const existing = await repository.findUserByEmail(dependencies.db, email)

      if (existing !== undefined) {
        return dependencies.transaction(({ tx }) => link(tx, existing))
      }

      if (input.provision === 'refuse') {
        throw new ExternalSignInError('unknown_identity')
      }

      return dependencies.transaction(async ({ tx }) => {
        let user: repository.UserRecord

        try {
          user = await repository.insertUser(tx, {
            id: dependencies.createId('user'),
            email,
            name,
            passwordHash: null,
            emailVerifiedAt: now,
          })
        } catch (error: unknown) {
          if (postgresErrorCode(error) !== UNIQUE_VIOLATION) {
            throw error
          }

          // Two first sign-ins for the same address at once. The other one won;
          // this is now an ordinary link.
          const raced = await repository.findUserByEmail(tx, email)

          if (raced === undefined) {
            throw error
          }

          return link(tx, raced)
        }

        const issued = await issueSession(tx, user, input.device, input.location, input.verifiedBy)

        return { ...issued, created: true }
      })
    },

    async logOut(actor: SessionActor): Promise<void> {
      await repository.deleteSession(dependencies.db, actor.userId, actor.sessionId)
    },

    async getAccount(actor: SessionActor): Promise<AccountView> {
      return toAccountView(await requireUser(actor.userId))
    },

    /**
     * Name and email, for every workspace at once. An account is global, so this
     * is not a change to one membership.
     *
     * Moving the address is treated like a password change, because it is one:
     * whoever controls the sign-in address controls the account through a
     * password reset. The current password must verify, every other session
     * ends, and the address being replaced is told, in case the caller was not
     * its owner.
     */
    async updateAccount(actor: SessionActor, changes: UpdateAccountChanges): Promise<AccountView> {
      const user = await requireUser(actor.userId)

      const values = {
        ...(changes.name === undefined ? {} : { name: requireText(changes.name, 'name') }),
        ...(changes.email === undefined
          ? {}
          : { email: requireText(normaliseEmail(changes.email), 'email') }),
      }

      // A passwordless account cannot prove itself this way. It sets a password
      // through the reset flow first, which is the same bar this check is.
      if (
        changes.email !== undefined &&
        (changes.currentPassword === undefined ||
          user.passwordHash === null ||
          !(await verifyPassword(user.passwordHash, changes.currentPassword)))
      ) {
        throw AppError.unauthorized('Current password is incorrect')
      }

      const previousEmail = user.email

      try {
        const updated = await dependencies.transaction(async ({ tx }) => {
          const saved = await repository.updateUserProfile(tx, actor.userId, values, dependencies.now())

          if (saved === undefined) {
            throw AppError.unauthorized('This session no longer belongs to an account')
          }

          if (changes.email !== undefined) {
            await repository.deleteOtherSessionsForUser(tx, actor.userId, actor.sessionId)
          }

          return saved
        })

        if (changes.email !== undefined) {
          const { text, html } = renderEmail(
            {
              intro: `Your Kelpie sign-in email changed from ${previousEmail} to ${updated.email}. If you did not make this change, reset your password right away.`,
            },
            dependencies.appBaseUrl,
          )

          await dependencies.email.send({
            to: previousEmail,
            subject: 'Your Kelpie sign-in email changed',
            body: text,
            html,
          })
        }

        return toAccountView(updated)
      } catch (error: unknown) {
        if (postgresErrorCode(error) === UNIQUE_VIOLATION) {
          // The caller typed this address, so naming the clash discloses nothing
          // they did not already supply. Same reasoning as signup.
          throw AppError.conflict('An account with that email already exists', [
            { field: 'email', message: 'Already registered' },
          ])
        }

        throw error
      }
    },

    async getPreferences(actor: SessionActor): Promise<PreferenceValues> {
      const stored = await repository.findPreferences(dependencies.db, actor.userId)

      return stored === undefined ? DEFAULT_PREFERENCES : toPreferenceValues(stored)
    },

    /**
     * Writes the whole row from defaults plus what is stored plus what changed,
     * so a first save and a later one take the same path and a repeat is a no-op.
     */
    async updatePreferences(
      actor: SessionActor,
      changes: PreferenceChanges,
    ): Promise<PreferenceValues> {
      await requireUser(actor.userId)

      return dependencies.transaction(async ({ tx }) => {
        const stored = await repository.findPreferences(tx, actor.userId)
        const values = applyPreferenceChanges(
          stored === undefined ? undefined : toPreferenceValues(stored),
          changes,
        )

        return toPreferenceValues(
          await repository.upsertPreferences(tx, {
            userId: actor.userId,
            ...values,
            updatedAt: dependencies.now(),
          }),
        )
      })
    },

    async listSessions(actor: SessionActor): Promise<readonly SessionView[]> {
      const records = await repository.listSessionsForUser(dependencies.db, actor.userId)

      return records.map((record) => ({
        id: record.id,
        device: record.device,
        location: record.location,
        lastActiveAt: record.lastActiveAt,
        current: record.id === actor.sessionId,
        signedInVia: record.signedInVia,
      }))
    },

    async revokeSession(actor: SessionActor, sessionId: string): Promise<void> {
      const removed = await repository.deleteSession(dependencies.db, actor.userId, sessionId)

      if (removed === 0) {
        // Another user's session id is indistinguishable from one that never
        // existed, which is what `api.md` requires of a cross-tenant miss.
        throw AppError.notFound('Session not found')
      }
    },

    /**
     * Always resolves, whether or not the address is registered. Telling a
     * stranger which addresses have accounts is the whole attack.
     */
    async requestPasswordReset(email: string): Promise<void> {
      const user = await repository.findUserByEmail(dependencies.db, normaliseEmail(email))

      if (user === undefined) {
        return
      }

      const now = dependencies.now()
      const token = newToken()

      await repository.insertPasswordResetToken(dependencies.db, {
        id: dependencies.createId('passwordResetToken'),
        userId: user.id,
        tokenHash: hashToken(token),
        expiresAt: new Date(now.getTime() + RESET_TOKEN_LIFETIME_MS),
      })

      const link = buildAppLink(dependencies.appBaseUrl, APP_LINK_PATHS.passwordReset, token)
      const { text, html } = renderEmail(
        {
          action: {
            instructions: 'Use this link within the hour to choose a new password:',
            buttonText: 'Reset password',
            link,
          },
          outro: 'If you did not ask for this, ignore it.',
        },
        dependencies.appBaseUrl,
      )

      await dependencies.email.send({
        to: user.email,
        subject: 'Reset your Kelpie password',
        body: text,
        html,
      })
    },

    /** Ends every session on success: a reset is how you recover a stolen account. */
    async confirmPasswordReset(token: string, newPassword: string): Promise<void> {
      if (newPassword.length < MINIMUM_PASSWORD_LENGTH) {
        throw AppError.validationFailed('Password is too short', [
          { field: 'password', message: `Must be at least ${MINIMUM_PASSWORD_LENGTH} characters` },
        ])
      }

      const now = dependencies.now()
      const record = await repository.findUsablePasswordResetToken(dependencies.db, hashToken(token), now)

      if (record === undefined) {
        throw AppError.unauthorized('That reset link is invalid or has expired')
      }

      const passwordHash = await hashPassword(newPassword)

      await dependencies.transaction(async ({ tx }) => {
        await repository.markPasswordResetTokenUsed(tx, record.id, now)
        await repository.updateUserPassword(tx, record.userId, passwordHash, now)
        await repository.deleteAllSessionsForUser(tx, record.userId)
      })
    },

    /** Keeps the caller signed in and ends every other session. */
    async changePassword(actor: SessionActor, currentPassword: string, newPassword: string): Promise<void> {
      if (newPassword.length < MINIMUM_PASSWORD_LENGTH) {
        throw AppError.validationFailed('Password is too short', [
          { field: 'new_password', message: `Must be at least ${MINIMUM_PASSWORD_LENGTH} characters` },
        ])
      }

      const user = await repository.findUserById(dependencies.db, actor.userId)

      if (
        user === undefined ||
        user.passwordHash === null ||
        !(await verifyPassword(user.passwordHash, currentPassword))
      ) {
        throw AppError.unauthorized('Current password is incorrect')
      }

      const now = dependencies.now()
      const passwordHash = await hashPassword(newPassword)

      await dependencies.transaction(async ({ tx }) => {
        await repository.updateUserPassword(tx, user.id, passwordHash, now)
        await repository.deleteOtherSessionsForUser(tx, user.id, actor.sessionId)
      })
    },

    async requestEmailVerification(actor: SessionActor): Promise<void> {
      const user = await requireUser(actor.userId)

      if (user.emailVerifiedAt !== null) {
        return
      }

      const now = dependencies.now()
      const token = newToken()

      await repository.insertEmailVerificationToken(dependencies.db, {
        id: dependencies.createId('emailVerificationToken'),
        userId: user.id,
        tokenHash: hashToken(token),
        expiresAt: new Date(now.getTime() + EMAIL_VERIFICATION_TOKEN_LIFETIME_MS),
      })

      await sendVerificationEmail(user.email, token)
    },

    async confirmEmailVerification(token: string): Promise<void> {
      const now = dependencies.now()
      const record = await repository.findUsableEmailVerificationToken(
        dependencies.db,
        hashToken(token),
        now,
      )

      if (record === undefined) {
        throw AppError.unauthorized('That verification link is invalid or has expired')
      }

      await dependencies.transaction(async ({ tx }) => {
        await repository.markEmailVerificationTokenUsed(tx, record.id, now)
        await repository.markEmailVerified(tx, record.userId, now)
      })
    },
  }
}
