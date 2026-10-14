/**
 * The one error type services throw and routes render. Wire shape and status
 * usage are fixed by the API contract; this module is the only place that mapping lives.
 */

export type ErrorCode =
  | 'bad_request'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'method_not_allowed'
  | 'conflict'
  | 'entitlement_required'
  | 'payload_too_large'
  | 'unsupported_media_type'
  | 'validation_failed'
  | 'rate_limited'
  | 'internal_error'

const statusByCode = {
  bad_request: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  // Extends the API's status list, for the MCP transport. Its Streamable HTTP
  // spec fixes 405 as the answer a server gives for the methods it does not
  // offer, and a client reads it as "stop trying" rather than "try again".
  method_not_allowed: 405,
  conflict: 409,
  // Extends the API's status list: the plan does not include this, which is
  // neither a role problem nor a conflict. 402 would imply Kelpie takes payment,
  // which a self-hosted install does not.
  entitlement_required: 403,
  // Extends the API's status list: the body is over the limit in
  // `lib/bodyLimit.ts`. A client reads 413 as "send less", not "fix a field".
  payload_too_large: 413,
  // Extends the API's status list: the body is not JSON (`lib/crossSiteGuard.ts`).
  unsupported_media_type: 415,
  validation_failed: 422,
  rate_limited: 429,
  internal_error: 500,
} as const satisfies Record<ErrorCode, number>

export type ErrorStatus = (typeof statusByCode)[ErrorCode]

export interface ErrorDetail {
  readonly field: string
  readonly message: string
}

export interface ErrorBody {
  readonly error: {
    readonly code: ErrorCode
    readonly message: string
    readonly details?: readonly ErrorDetail[]
  }
}

export class AppError extends Error {
  readonly code: ErrorCode
  readonly status: ErrorStatus
  readonly details: readonly ErrorDetail[] | undefined

  constructor(code: ErrorCode, message: string, details?: readonly ErrorDetail[]) {
    super(message)
    this.name = 'AppError'
    this.code = code
    this.status = statusByCode[code]
    this.details = details
  }

  static notFound(message = 'Not found'): AppError {
    return new AppError('not_found', message)
  }

  static unauthorized(message = 'Missing or invalid credentials'): AppError {
    return new AppError('unauthorized', message)
  }

  static validationFailed(message: string, details: readonly ErrorDetail[]): AppError {
    return new AppError('validation_failed', message, details)
  }

  static conflict(message: string, details?: readonly ErrorDetail[]): AppError {
    return new AppError('conflict', message, details)
  }

  static rateLimited(message = 'Too many requests'): AppError {
    return new AppError('rate_limited', message)
  }
}

/**
 * Why core refused an identity a module handed to `completeExternalSignIn`.
 *
 * A reason rather than a message, so a provider module can branch on it (to
 * redirect somewhere useful, say) without matching on English text.
 */
export type ExternalSignInRefusal = 'email_unverified' | 'unknown_identity' | 'signups_closed'

const EXTERNAL_SIGN_IN_CODE: Record<ExternalSignInRefusal, ErrorCode> = {
  email_unverified: 'unauthorized',
  unknown_identity: 'forbidden',
  signups_closed: 'forbidden',
}

const EXTERNAL_SIGN_IN_MESSAGE: Record<ExternalSignInRefusal, string> = {
  email_unverified: 'The identity provider did not verify this email address',
  unknown_identity: 'No account exists for this identity',
  signups_closed: 'Signups are closed on this instance',
}

/**
 * An external sign-in core would not complete.
 *
 * An `AppError`, so an uncaught one still renders as the standard error body. No new
 * `ErrorCode`: refusing an unverified identity is an ordinary `401`, and both
 * refusing to provision and signups being closed are an ordinary `403`.
 */
export class ExternalSignInError extends AppError {
  readonly reason: ExternalSignInRefusal

  constructor(reason: ExternalSignInRefusal) {
    super(EXTERNAL_SIGN_IN_CODE[reason], EXTERNAL_SIGN_IN_MESSAGE[reason])
    this.name = 'ExternalSignInError'
    this.reason = reason
  }
}

/**
 * Renders an `AppError` into the wire error body. `details` is omitted
 * rather than sent as null when the error carries none.
 */
export function toErrorBody(error: AppError): ErrorBody {
  return {
    error:
      error.details === undefined
        ? { code: error.code, message: error.message }
        : { code: error.code, message: error.message, details: error.details },
  }
}

/**
 * The body sent for anything thrown that is not an `AppError`. The real cause is
 * logged server-side; the client is told nothing about it.
 */
export function internalErrorBody(): ErrorBody {
  return { error: { code: 'internal_error', message: 'Internal server error' } }
}

/** One problem reported by a schema parse, in the shape Zod produces. */
export interface ValidationIssue {
  readonly path: readonly PropertyKey[]
  readonly message: string
  /** Zod's issue code. Only `unrecognized_keys` is treated specially. */
  readonly code?: string
  /** The offending field names, when the issue is an unrecognised key. */
  readonly keys?: readonly string[]
}

/** Renders a parse failure as `path: message`, or just the message at the root. */
export function describeValidationIssue(issue: ValidationIssue): string {
  const path = issue.path.map(String).join('.')

  return path.length > 0 ? `${path}: ${issue.message}` : issue.message
}

/**
 * Turns parse failures into the field-level `details` of a `422` response.
 *
 * An unrecognised key is reported against the key itself. Zod raises it at the
 * object, so its path is empty, and `details` is where a client looks to find out
 * which field it got wrong.
 */
export function toErrorDetails(issues: readonly ValidationIssue[]): readonly ErrorDetail[] {
  return issues.flatMap((issue) => {
    if (issue.code === 'unrecognized_keys' && issue.keys !== undefined) {
      const prefix = issue.path.map(String).join('.')

      return issue.keys.map((key) => ({
        field: prefix.length > 0 ? `${prefix}.${key}` : key,
        message: 'Unknown field',
      }))
    }

    return [{ field: issue.path.map(String).join('.'), message: issue.message }]
  })
}

/**
 * Renders an unknown thrown value as one diagnostic line. Driver errors often
 * carry an empty `message` and put the useful part in `name` or `code`, so all
 * three are included.
 */
export function describeThrown(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error)
  }

  const code = 'code' in error && typeof error.code === 'string' ? error.code : ''
  const parts = [error.name, code, error.message].filter((part) => part.length > 0)

  return parts.join(': ')
}

/** A Node or undici error code: capitals, digits and underscores only. */
const ERROR_CODE_PATTERN = /^[A-Z][A-Z0-9_]*$/u

function errorCodeOf(value: unknown): string | undefined {
  if (!(value instanceof Error) || !('code' in value) || typeof value.code !== 'string') {
    return undefined
  }

  return ERROR_CODE_PATTERN.test(value.code) ? value.code : undefined
}

/**
 * Cause messages that are fixed text, with no address or host in them, keyed
 * to the word the reason shows. `fetch` refuses a port the Fetch standard
 * blocks (1, 25, 6000, …) with the message `bad port` and no code; without
 * this the reason would say only "fetch failed".
 */
const FIXED_CAUSE_MESSAGES: Readonly<Record<string, string>> = {
  'bad port': 'bad port',
}

/** The cause, and the members of an `AggregateError` cause: one per address a connection tried. */
function causeMembersOf(error: Error): readonly unknown[] {
  const cause: unknown = error.cause

  return cause instanceof AggregateError ? [cause, ...(cause.errors as unknown[])] : [cause]
}

/**
 * The codes on the cause of `error`, for example `ECONNREFUSED`, `ENOTFOUND`
 * or `CERT_HAS_EXPIRED`, or the word for a fixed message with no code.
 */
function causeCodesOf(error: Error): readonly string[] {
  const codes = causeMembersOf(error)
    .map((member) => errorCodeOf(member) ?? fixedMessageOf(member))
    .filter((code): code is string => code !== undefined)

  return [...new Set(codes)]
}

function fixedMessageOf(value: unknown): string | undefined {
  return value instanceof Error ? FIXED_CAUSE_MESSAGES[value.message] : undefined
}

/**
 * The whole cause of `error`, messages included, for the server log only.
 *
 * Node's network messages hold the address it connected to (`connect
 * ECONNREFUSED 10.0.0.5:443`). That is what an operator needs to find a
 * fault, and what a reason that the people of a workspace read must never
 * hold. Use `describeThrownWithCause` for such a reason.
 *
 * @returns Undefined when there is no cause.
 */
export function describeCauseForLog(error: unknown): string | undefined {
  if (!(error instanceof Error) || error.cause === undefined) {
    return undefined
  }

  return causeMembersOf(error).map(describeThrown).join('; ')
}

/**
 * `describeThrown`, plus the code of the error's cause.
 *
 * `fetch` rejects with `TypeError: fetch failed` for every network fault, and
 * says which one only in `cause`. A reason without it tells a reader nothing.
 *
 * Only the cause's `code` is added, never its `message`. Node writes the
 * address it connected to into that message (`connect ECONNREFUSED
 * 10.0.0.5:443`), and the reason of an outbound call is shown to the people
 * of a workspace. The address a host name resolved to inside the deployment's
 * network is not theirs to read. A code is a fixed word, and a value that is
 * not shaped like one is left out.
 */
export function describeThrownWithCause(error: unknown): string {
  const described = describeThrown(error)

  if (!(error instanceof Error)) {
    return described
  }

  const codes = causeCodesOf(error)

  return codes.length === 0 ? described : `${described} (${codes.join(', ')})`
}

/**
 * True when `error`, or its cause, or a member of an `AggregateError` cause,
 * carries `code`. A DNS failure reaches a sender from the egress check as the
 * resolver's own error, and from `fetch` as the cause of a `TypeError`.
 */
export function hasErrorCode(error: unknown, code: string): boolean {
  if (errorCodeOf(error) === code) {
    return true
  }

  return error instanceof Error && causeMembersOf(error).some((member) => errorCodeOf(member) === code)
}
