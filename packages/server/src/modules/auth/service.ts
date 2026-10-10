import { isSingleEmailAddress } from '../../lib/emailAddress.ts'
import { AppError, ExternalSignInError } from '../../lib/errors.ts'
import type { IdFactory } from '../../lib/ids.ts'
import { UNIQUE_VIOLATION, postgresErrorCode } from '../../lib/database.ts'
import type { Database } from '../../lib/database.ts'
import {
  MINIMUM_PASSWORD_LENGTH,
  hashPassword,
  verifyLoginPassword,
  verifyPassword,
} from '../../lib/passwords.ts'
import { generateToken, hashToken } from '../../lib/tokens.ts'
import type { VerifiedIdentity } from '../../runtime/module.ts'
import type { TransactionScope } from '../../runtime/transaction.ts'
import * as apiKeyRepository from '../api-keys/repository.ts'
import * as oauthRepository from '../oauth/repository.ts'
import type { MemberRole } from '../workspace/roles.ts'
import { parseMemberRole } from '../workspace/roles.ts'
import type { SessionActor } from './actor.ts'
import type { AuthEmailJobs } from './emailJobs.ts'
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
/**
 * The longest address a reset request puts on the queue. The route sets no
 * length limit and the caller is a stranger, so without one a job payload
 * could be as large as a request body. No mailbox has a longer address.
 */
const LONGEST_EMAIL_ADDRESS = 320

export interface AuthDependencies {
  readonly db: Database
  readonly transaction: TransactionScope
  readonly createId: IdFactory
  readonly now: () => Date
  /**
   * The emails this service asks for. It sends none itself: each one is a job
   * added inside the transaction that made it necessary. See `emailJobs.ts`.
   */
  readonly emailJobs: AuthEmailJobs
  /**
   * Whether a brand-new account may be created, through `signUp` or
   * `completeExternalSignIn` provisioning. Joining an existing workspace via
   * invite, and workspace creation by an already-verified account, are
   * unaffected either way — this only gates the account-creation step itself.
   */
  readonly signupsEnabled: boolean
  /** Injected only so tests can pin session tokens. Production uses the crypto default. */
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

/** What `GET /v1/auth/me` and `POST /v1/auth/workspace` answer with. */
export interface MeView {
  readonly userId: string
  readonly sessionId: string
  readonly workspaceId: string | null
  readonly role: MemberRole | null
  readonly emailVerified: boolean
}

/** One membership on `GET /v1/auth/workspaces`. */
export interface AccountWorkspaceView {
  readonly id: string
  readonly name: string
  readonly timezone: string
  readonly role: MemberRole
}

export interface SignUpInput {
  readonly email: string
  readonly name: string
  readonly password: string
  readonly device?: string
  readonly location?: string
}

/** Only what the caller sent. An absent field is left alone. */
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

/** Emails are stored and compared lowercase. */
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

/**
 * Refuses a new sign-in address that is not exactly one address. Mail goes to
 * this value, and a list of addresses would send one verification email to
 * every address in it. Login does not call this: an account stored before the
 * check existed must still be able to sign in.
 */
function requireSingleAddress(email: string): string {
  if (!isSingleEmailAddress(email)) {
    throw AppError.validationFailed('Use a valid email address', [
      { field: 'email', message: 'Must be one email address' },
    ])
  }

  return email
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
  /** Workspaces this account belongs to. Oldest membership first. */
  listWorkspaces(actor: SessionActor): Promise<readonly AccountWorkspaceView[]>
  /** Moves this session into a membership. Answers the same shape as `GET /v1/auth/me`. */
  switchWorkspace(actor: SessionActor, workspaceId: string): Promise<MeView>
  /** Resolves whether or not the address is registered, after the same work for both. */
  requestPasswordReset(email: string): Promise<void>
  confirmPasswordReset(token: string, newPassword: string): Promise<void>
  changePassword(actor: SessionActor, currentPassword: string, newPassword: string): Promise<void>
  /** Queues a fresh verification email. A no-op once already verified. */
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

  return {
    /** Creates the account only. The first workspace comes from onboarding. */
    async signUp(input: SignUpInput): Promise<IssuedSession> {
      if (!dependencies.signupsEnabled) {
        throw new AppError('forbidden', 'Signups are closed on this instance')
      }

      if (input.password.length < MINIMUM_PASSWORD_LENGTH) {
        throw AppError.validationFailed('Password is too short', [
          { field: 'password', message: `Must be at least ${MINIMUM_PASSWORD_LENGTH} characters` },
        ])
      }

      const email = requireSingleAddress(normaliseEmail(input.email))
      const passwordHash = await hashPassword(input.password)
      const now = dependencies.now()

      return dependencies.transaction(async ({ tx, jobs }) => {
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

        // On the same transaction, so a rolled-back signup never emails a
        // link and a committed one cannot lose its email. The job makes the
        // token when it runs.
        await jobs.enqueue(dependencies.emailJobs.verification, {
          userId: user.id,
          email: user.email,
          requestedAt: now.toISOString(),
        })

        return issueSession(tx, user, input.device, input.location)
      })
    },

    async logIn(input: LogInInput): Promise<IssuedSession> {
      const user = await repository.findUserByEmail(dependencies.db, normaliseEmail(input.email))

      // One verify in every case: against the account's hash, or against a
      // placeholder when the account is unknown or has no password. All three
      // cases thus take the same time to answer.
      const matches = await verifyLoginPassword(user?.passwordHash, input.password)

      // The null check is the guard, not the placeholder hash. An account
      // with no password must refuse a password login whatever the verify says.
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

      // The instance-level gate applies before the module's own policy: a
      // module that would provision does not get to override it.
      if (!dependencies.signupsEnabled) {
        throw new ExternalSignInError('signups_closed')
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
     *
     * A real change of address also resets verification and queues a fresh
     * verification email to the new one. Verifying the old address proves nothing about the
     * new one, and leaving the flag set would let anyone who can rename an
     * unregistered account onto a given address inherit "verified" for free —
     * exactly the mailbox-ownership proof signup's own token exists to require.
     * Submitting the address already on file is not a change and resets nothing.
     */
    async updateAccount(actor: SessionActor, changes: UpdateAccountChanges): Promise<AccountView> {
      const user = await requireUser(actor.userId)

      const nextEmail =
        changes.email === undefined ? undefined : requireText(normaliseEmail(changes.email), 'email')
      const emailChanging = nextEmail !== undefined && nextEmail !== user.email

      // Only a real change is checked. The address already on file is not new
      // input, and an older account may hold one this check would refuse.
      if (emailChanging) {
        requireSingleAddress(nextEmail)
      }

      const values = {
        ...(changes.name === undefined ? {} : { name: requireText(changes.name, 'name') }),
        ...(nextEmail === undefined ? {} : { email: nextEmail }),
        ...(emailChanging ? { emailVerifiedAt: null } : {}),
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
      const now = dependencies.now()

      try {
        const updated = await dependencies.transaction(async ({ tx, jobs }) => {
          const saved = await repository.updateUserProfile(tx, actor.userId, values, now)

          if (saved === undefined) {
            throw AppError.unauthorized('This session no longer belongs to an account')
          }

          if (changes.email !== undefined) {
            await repository.deleteOtherSessionsForUser(tx, actor.userId, actor.sessionId)
          }

          // Two jobs, on the same transaction as the change: a rolled-back
          // change emails nobody, and one email that fails is retried alone
          // and does not hold back the other. The address already on file is
          // not a change, so it queues neither.
          if (emailChanging) {
            await jobs.enqueue(dependencies.emailJobs.emailChangeNotice, {
              previousEmail,
              newEmail: saved.email,
            })

            await jobs.enqueue(dependencies.emailJobs.verification, {
              userId: saved.id,
              email: saved.email,
              requestedAt: now.toISOString(),
            })
          }

          return saved
        })

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
        // existed, which is what a cross-tenant miss requires.
        throw AppError.notFound('Session not found')
      }
    },

    async listWorkspaces(actor: SessionActor): Promise<readonly AccountWorkspaceView[]> {
      const rows = await repository.listWorkspacesForUser(dependencies.db, actor.userId)

      return rows.map((row) => {
        const role = parseMemberRole(row.role)

        if (role === undefined) {
          throw new Error(`workspace_members.role holds "${row.role}", which its check constraint forbids`)
        }

        return {
          id: row.id,
          name: row.name,
          timezone: row.timezone,
          role,
        }
      })
    },

    async switchWorkspace(actor: SessionActor, workspaceId: string): Promise<MeView> {
      const membership = await repository.findMembership(dependencies.db, workspaceId, actor.userId)

      if (membership === undefined) {
        throw AppError.notFound('Workspace not found')
      }

      const role = parseMemberRole(membership.role)

      if (role === undefined) {
        throw new Error(`workspace_members.role holds "${membership.role}", which its check constraint forbids`)
      }

      await repository.setActiveWorkspace(dependencies.db, actor.sessionId, workspaceId)
      const user = await requireUser(actor.userId)

      return {
        userId: actor.userId,
        sessionId: actor.sessionId,
        workspaceId,
        role,
        emailVerified: user.emailVerifiedAt !== null,
      }
    },

    /**
     * Always resolves, whether or not the address is registered. Telling a
     * stranger which addresses have accounts is the whole attack.
     *
     * The request does not look the account up. It adds one job for any
     * address, and the job finds the account, or does not, after the caller
     * has its answer. So both cases do the same work here, take the same time,
     * and a mail server that is down changes neither.
     */
    async requestPasswordReset(email: string): Promise<void> {
      const address = normaliseEmail(email)

      if (address.length === 0 || address.length > LONGEST_EMAIL_ADDRESS) {
        return
      }

      await dependencies.transaction(async ({ jobs }) => {
        await jobs.enqueue(dependencies.emailJobs.passwordReset, {
          email: address,
          requestedAt: dependencies.now().toISOString(),
        })
      })
    },

    /**
     * A reset is how you recover a stolen account, so success ends everything
     * the thief could still hold: every session, every other reset link, every
     * personal API key and every connected app. Workspace keys belong to the
     * workspace, not the account, and stay.
     */
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
        // A link sent to an address the account has since left is not a link
        // to this account. The same answer as an unknown token.
        const user = await repository.findUserById(tx, record.userId)

        if (user === undefined || record.email === null || user.email !== record.email) {
          throw AppError.unauthorized('That reset link is invalid or has expired')
        }

        // The read above is not the guard: two requests can both pass it with
        // the same link. Only the one whose update lands may go on.
        if (!(await repository.spendPasswordResetToken(tx, record.id, now))) {
          throw AppError.unauthorized('That reset link is invalid or has expired')
        }

        await repository.closeOpenPasswordResetTokens(tx, record.userId, now)
        await repository.updateUserPassword(tx, record.userId, passwordHash, now)
        await repository.deleteAllSessionsForUser(tx, record.userId)
        await apiKeyRepository.deletePersonalKeysForUser(tx, record.userId)
        await oauthRepository.deleteConnectionsForUser(tx, record.userId)
      })
    },

    /**
     * Keeps the caller signed in, ends every other session, and closes every
     * open reset link.
     *
     * Personal API keys and connected apps stay. A routine change is not a
     * report of compromise, and ending them would stop integrations the
     * caller set up and can still revoke one by one. A reset ends them.
     */
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
        await repository.closeOpenPasswordResetTokens(tx, user.id, now)
      })
    },

    async requestEmailVerification(actor: SessionActor): Promise<void> {
      const user = await requireUser(actor.userId)

      if (user.emailVerifiedAt !== null) {
        return
      }

      await dependencies.transaction(async ({ jobs }) => {
        await jobs.enqueue(dependencies.emailJobs.verification, {
          userId: user.id,
          email: user.email,
          requestedAt: dependencies.now().toISOString(),
        })
      })
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

      const { email } = record

      await dependencies.transaction(async ({ tx }) => {
        // The token verifies the address it was sent to and no other. An
        // account that has changed address since needs the link sent to the
        // new one. The same answer as an unknown token.
        const user = await repository.findUserById(tx, record.userId)

        if (user === undefined || email === null || user.email !== email) {
          throw AppError.unauthorized('That verification link is invalid or has expired')
        }

        // The read above is not the guard: two requests can both pass it with
        // the same link. Only the one whose update lands may go on.
        if (!(await repository.spendEmailVerificationToken(tx, record.id, now))) {
          throw AppError.unauthorized('That verification link is invalid or has expired')
        }

        await repository.markEmailAddressVerified(tx, record.userId, email, now)
      })
    },
  }
}
