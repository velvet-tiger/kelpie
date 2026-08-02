import type { EmailSender } from '../../lib/email.ts'
import { AppError } from '../../lib/errors.ts'
import type { IdFactory } from '../../lib/ids.ts'
import { UNIQUE_VIOLATION, postgresErrorCode } from '../../lib/database.ts'
import type { Database } from '../../lib/database.ts'
import { MINIMUM_PASSWORD_LENGTH, hashPassword, verifyPassword } from '../../lib/passwords.ts'
import { generateToken, hashToken } from '../../lib/tokens.ts'
import type { TransactionScope } from '../../runtime/transaction.ts'
import type { Actor } from './actor.ts'
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

export interface AuthDependencies {
  readonly db: Database
  readonly transaction: TransactionScope
  readonly email: EmailSender
  readonly createId: IdFactory
  readonly now: () => Date
  /** Injected only so tests can pin tokens. Production uses the crypto default. */
  readonly newToken?: () => string
}

export interface AccountView {
  readonly id: string
  readonly email: string
  readonly name: string
}

/** A session plus the plaintext token, which exists only in this return value. */
export interface IssuedSession {
  readonly account: AccountView
  readonly sessionToken: string
  readonly expiresAt: Date
  readonly activeWorkspaceId: string | null
}

export interface SessionView {
  readonly id: string
  readonly device: string | null
  readonly location: string | null
  readonly lastActiveAt: Date
  readonly current: boolean
}

export interface SignUpInput {
  readonly email: string
  readonly name: string
  readonly password: string
  readonly device?: string
  readonly location?: string
}

export interface LogInInput {
  readonly email: string
  readonly password: string
  readonly device?: string
  readonly location?: string
}

function toAccountView(user: repository.UserRecord): AccountView {
  return { id: user.id, email: user.email, name: user.name }
}

/** Emails are stored and compared lowercase, per `schema.md`. */
function normaliseEmail(email: string): string {
  return email.trim().toLowerCase()
}

export interface AuthService {
  /** Creates the account only. The first workspace comes from onboarding. */
  signUp(input: SignUpInput): Promise<IssuedSession>
  logIn(input: LogInInput): Promise<IssuedSession>
  logOut(actor: Actor): Promise<void>
  listSessions(actor: Actor): Promise<readonly SessionView[]>
  revokeSession(actor: Actor, sessionId: string): Promise<void>
  /** Resolves whether or not the address is registered. */
  requestPasswordReset(email: string, resetUrlTemplate: string): Promise<void>
  confirmPasswordReset(token: string, newPassword: string): Promise<void>
  changePassword(actor: Actor, currentPassword: string, newPassword: string): Promise<void>
}

export function createAuthService(dependencies: AuthDependencies): AuthService {
  const newToken = dependencies.newToken ?? generateToken

  async function issueSession(
    db: repository.Queryable,
    user: repository.UserRecord,
    device: string | undefined,
    location: string | undefined,
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
      if (input.password.length < MINIMUM_PASSWORD_LENGTH) {
        throw AppError.validationFailed('Password is too short', [
          { field: 'password', message: `Must be at least ${MINIMUM_PASSWORD_LENGTH} characters` },
        ])
      }

      const email = normaliseEmail(input.email)
      const passwordHash = await hashPassword(input.password)

      return dependencies.transaction(async ({ tx }) => {
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

        return issueSession(tx, user, input.device, input.location)
      })
    },

    async logIn(input: LogInInput): Promise<IssuedSession> {
      const user = await repository.findUserByEmail(dependencies.db, normaliseEmail(input.email))

      // Hash a throwaway password when the user is unknown, so a missing account
      // and a wrong password take the same time to answer.
      const storedHash = user?.passwordHash ?? (await hashPassword('not-a-real-password-placeholder'))

      if (!(await verifyPassword(storedHash, input.password)) || user === undefined) {
        throw AppError.unauthorized('Email or password is incorrect')
      }

      return dependencies.transaction(({ tx }) => issueSession(tx, user, input.device, input.location))
    },

    async logOut(actor: Actor): Promise<void> {
      await repository.deleteSession(dependencies.db, actor.userId, actor.sessionId)
    },

    async listSessions(actor: Actor): Promise<readonly SessionView[]> {
      const records = await repository.listSessionsForUser(dependencies.db, actor.userId)

      return records.map((record) => ({
        id: record.id,
        device: record.device,
        location: record.location,
        lastActiveAt: record.lastActiveAt,
        current: record.id === actor.sessionId,
      }))
    },

    async revokeSession(actor: Actor, sessionId: string): Promise<void> {
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
    async requestPasswordReset(email: string, resetUrlTemplate: string): Promise<void> {
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

      await dependencies.email.send({
        to: user.email,
        subject: 'Reset your Kelpie password',
        body: `Use this link within the hour to choose a new password:\n\n${resetUrlTemplate.replace('{token}', token)}\n\nIf you did not ask for this, ignore it.`,
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
    async changePassword(actor: Actor, currentPassword: string, newPassword: string): Promise<void> {
      if (newPassword.length < MINIMUM_PASSWORD_LENGTH) {
        throw AppError.validationFailed('Password is too short', [
          { field: 'new_password', message: `Must be at least ${MINIMUM_PASSWORD_LENGTH} characters` },
        ])
      }

      const user = await repository.findUserById(dependencies.db, actor.userId)

      if (user === undefined || !(await verifyPassword(user.passwordHash, currentPassword))) {
        throw AppError.unauthorized('Current password is incorrect')
      }

      const now = dependencies.now()
      const passwordHash = await hashPassword(newPassword)

      await dependencies.transaction(async ({ tx }) => {
        await repository.updateUserPassword(tx, user.id, passwordHash, now)
        await repository.deleteOtherSessionsForUser(tx, user.id, actor.sessionId)
      })
    },
  }
}
