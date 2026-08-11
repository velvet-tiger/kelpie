/**
 * The one error type services throw and routes render. Wire shape and status
 * usage are fixed by `api.md`; this module is the only place that mapping lives.
 */

export type ErrorCode =
  | 'bad_request'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'method_not_allowed'
  | 'conflict'
  | 'entitlement_required'
  | 'validation_failed'
  | 'rate_limited'
  | 'internal_error'

const statusByCode = {
  bad_request: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  // Extends the api.md status list, for the MCP transport. Its Streamable HTTP
  // spec fixes 405 as the answer a server gives for the methods it does not
  // offer, and a client reads it as "stop trying" rather than "try again".
  method_not_allowed: 405,
  conflict: 409,
  // Extends the api.md status list: the plan does not include this, which is
  // neither a role problem nor a conflict. 402 would imply Kelpie takes payment,
  // which a self-hosted install does not.
  entitlement_required: 403,
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
 * Renders an `AppError` into the wire body from `api.md`. `details` is omitted
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
