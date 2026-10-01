import { createHmac, hkdfSync, timingSafeEqual } from 'node:crypto'
import type { FormSpamReason } from '@kelpie/schemas'

import type { CaptchaAccess } from '../../lib/captcha.ts'
import type { Logger } from '../../lib/logger.ts'
import type { SecretEncryptionConfig } from '../../lib/secrets.ts'

/**
 * The spam check on a public submit.
 *
 * Three parts, and none of them stores anything:
 *
 * - A **honeypot**. The embed has a text input no person can see. A bot that
 *   fills every input fills it, and the embed sends its value as `trap`.
 * - A **token**. The embed asks for one when the page loads and sends it back
 *   with the submit. It is signed, names the form and carries the time it was
 *   issued, so the check knows the submit came through a page that asked first
 *   and how long the visitor took. A bot that posts JSON to the submit URL
 *   has no token; a bot that submits the moment the page loads is too fast.
 * - A **CAPTCHA**, when the deployment picked a provider (`lib/captcha.ts`).
 *
 * A submit that fails is not refused. It is stored as `spam` and the caller
 * gets the same `201`, so a bot learns nothing and a person wrongly caught is
 * one click from being released (`submission.ts`).
 *
 * What this does not stop: a bot written for Kelpie that fetches a token, waits,
 * and submits. The token is not single-use, because that needs a table and a
 * write on every page view. A CAPTCHA provider is the control for that bot.
 */

/** A token older than this is `token_expired`. Long, because a tab stays open over lunch. */
export const SPAM_TOKEN_MAX_AGE_MS = 24 * 60 * 60 * 1000

/** `spam` submissions older than this are deleted when the next one arrives. */
export const SPAM_RETENTION_DAYS = 30

const TOKEN_VERSION = 'v1'

/** Separates this key from every other use of the deployment's secret key. */
const KEY_PURPOSE = 'kelpie.forms.spam-token.v1'

export interface SpamTokens {
  /** A token for `formId`, issued now. Safe in a URL or a JSON string. */
  issue(formId: string): string
  /**
   * @returns When the token was issued, or undefined when it is malformed, was
   *   issued for another form, or was not signed by this deployment.
   */
  readIssuedAt(formId: string, token: string): Date | undefined
}

function deriveKey(secret: string): Buffer {
  return Buffer.from(hkdfSync('sha256', Buffer.from(secret, 'base64'), Buffer.alloc(0), KEY_PURPOSE, 32))
}

function sign(key: Buffer, formId: string, issuedAt: string): Buffer {
  return createHmac('sha256', key).update(`${formId}.${issuedAt}`).digest()
}

/**
 * Tokens signed with a key derived from the deployment's secret encryption key,
 * so every instance of a deployment accepts a token any of them issued and
 * there is no second secret to configure. A token signed under the previous key
 * is accepted while that key is configured, so a key rotation does not put a
 * day of real submits in quarantine.
 */
export function createSpamTokens(secrets: SecretEncryptionConfig, now: () => Date): SpamTokens {
  const current = deriveKey(secrets.SECRET_ENCRYPTION_KEY)
  const previous =
    secrets.SECRET_ENCRYPTION_KEY_PREVIOUS === undefined ||
    secrets.SECRET_ENCRYPTION_KEY_PREVIOUS.trim().length === 0
      ? undefined
      : deriveKey(secrets.SECRET_ENCRYPTION_KEY_PREVIOUS)

  return {
    issue(formId) {
      const issuedAt = now().getTime().toString(36)

      return `${TOKEN_VERSION}.${issuedAt}.${sign(current, formId, issuedAt).toString('base64url')}`
    },

    readIssuedAt(formId, token) {
      const [version, issuedAt, signature, ...rest] = token.split('.')

      if (
        version !== TOKEN_VERSION ||
        issuedAt === undefined ||
        signature === undefined ||
        rest.length > 0 ||
        !/^[0-9a-z]{1,12}$/u.test(issuedAt)
      ) {
        return undefined
      }

      const given = Buffer.from(signature, 'base64url')
      const signed = [current, ...(previous === undefined ? [] : [previous])].some((key) => {
        const expected = sign(key, formId, issuedAt)

        return given.length === expected.length && timingSafeEqual(given, expected)
      })

      return signed ? new Date(Number.parseInt(issuedAt, 36)) : undefined
    },
  }
}

/** What a submit carries for the check, beside its answers. Every part is optional on the wire. */
export interface SpamCheckInput {
  readonly token?: string | undefined
  /** The honeypot's value. A person leaves it empty. */
  readonly trap?: string | undefined
  readonly captchaResponse?: string | undefined
}

export interface SpamCheckDependencies {
  readonly tokens: SpamTokens
  readonly captcha: CaptchaAccess
  readonly now: () => Date
  /** A submit sooner than this after its token is `too_fast`. Zero turns the rule off. */
  readonly minimumSeconds: number
  readonly log: Logger
}

export interface SpamCheck {
  /**
   * @param form `requireSpamCheck` is the form's setting. Off, nothing is
   *   checked and every submit passes: a site that posts JSON from its own
   *   form has no token to send.
   * @returns Why the submit is spam, or null when it passes.
   */
  check(
    form: { readonly id: string; readonly requireSpamCheck: boolean },
    input: SpamCheckInput,
  ): Promise<FormSpamReason | null>
}

export function createSpamCheck(dependencies: SpamCheckDependencies): SpamCheck {
  function checkToken(formId: string, token: string): FormSpamReason | null {
    const issuedAt = dependencies.tokens.readIssuedAt(formId, token)

    if (issuedAt === undefined) {
      return 'token_invalid'
    }

    const age = dependencies.now().getTime() - issuedAt.getTime()

    if (age > SPAM_TOKEN_MAX_AGE_MS) {
      return 'token_expired'
    }

    return age < dependencies.minimumSeconds * 1000 ? 'too_fast' : null
  }

  async function checkCaptcha(response: string | undefined): Promise<FormSpamReason | null> {
    const provider = dependencies.captcha.current()

    if (provider === undefined) {
      return null
    }

    if (response === undefined || response.length === 0) {
      return 'captcha_missing'
    }

    try {
      return (await provider.verify(response)) ? null : 'captcha_failed'
    } catch (error: unknown) {
      // The vendor is down, which is not the visitor's fault. The honeypot and
      // the token have already passed, so the submit goes through.
      dependencies.log.warn('CAPTCHA provider could not be reached; the submit was accepted', {
        error: error instanceof Error ? error.message : String(error),
      })

      return null
    }
  }

  return {
    async check(form, input) {
      if (!form.requireSpamCheck) {
        return null
      }

      // Cheapest and surest first: nothing but a bot fills a field no person sees.
      if (input.trap !== undefined && input.trap.length > 0) {
        return 'honeypot'
      }

      if (input.token === undefined || input.token.length === 0) {
        return 'token_missing'
      }

      // The vendor is asked last, so a submit the token already condemns costs
      // no request to it.
      return checkToken(form.id, input.token) ?? (await checkCaptcha(input.captchaResponse))
    },
  }
}
