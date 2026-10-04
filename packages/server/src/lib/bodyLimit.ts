import type { MiddlewareHandler } from 'hono'
import { bodyLimit } from 'hono/body-limit'

import { MAX_IMPORT_FILE_BYTES } from '@kelpie/schemas'

import { AppError } from './errors.ts'
import { PUBLIC_ROUTE_PREFIX } from './http.ts'

/**
 * The most bytes one request body may carry.
 *
 * Without a limit, a handler that reads a body buffers all of it, and one
 * process serves every workspace. Some of the routes that read a body take no
 * credentials. So the limit sits in front of every route, and a request over it
 * is refused with `413` before a handler runs.
 *
 * A request that states its `Content-Length` is refused on the header alone.
 * One that does not is read up to the limit and no further.
 */

const KIB = 1024
const MIB = 1024 * KIB

/** A public form submit: a set of short answers from somebody with no credentials. */
export const MAX_PUBLIC_BODY_BYTES = 256 * KIB

/** Everything else: JSON for one record, one handbook page, one batch of ids. */
export const MAX_BODY_BYTES = MIB

/** The import upload: the file limit plus the multipart framing and the other fields. */
export const MAX_IMPORT_BODY_BYTES = MAX_IMPORT_FILE_BYTES + MIB

/**
 * `/mcp`: the import tools take the same file as a JSON string, which is longer
 * than the file because each line break and quotation mark is escaped.
 */
export const MAX_MCP_BODY_BYTES = Math.ceil(MAX_IMPORT_FILE_BYTES * 1.5)

const IMPORT_UPLOAD_PATH = '/v1/import/jobs'

/** The limit for one path. Exported for tests. */
export function maxBodyBytesFor(path: string, mcpPath: string): number {
  if (path === mcpPath) {
    return MAX_MCP_BODY_BYTES
  }

  if (path === IMPORT_UPLOAD_PATH) {
    return MAX_IMPORT_BODY_BYTES
  }

  if (path.startsWith(`${PUBLIC_ROUTE_PREFIX}/`)) {
    return MAX_PUBLIC_BODY_BYTES
  }

  return MAX_BODY_BYTES
}

function describeBytes(bytes: number): string {
  return bytes >= MIB ? `${String(Math.floor(bytes / MIB))} MB` : `${String(bytes / KIB)} KB`
}

function limitOf(maxSize: number): MiddlewareHandler {
  return bodyLimit({
    maxSize,
    onError: () => {
      throw new AppError(
        'payload_too_large',
        `The request body may be at most ${describeBytes(maxSize)}`,
      )
    },
  })
}

/** One middleware for `*` that applies the limit of the path it is on. */
export function createBodyLimitMiddleware(mcpPath: string): MiddlewareHandler {
  const handlers = new Map<number, MiddlewareHandler>()

  return (context, next) => {
    const maxSize = maxBodyBytesFor(context.req.path, mcpPath)
    let handler = handlers.get(maxSize)

    if (handler === undefined) {
      handler = limitOf(maxSize)
      handlers.set(maxSize, handler)
    }

    return handler(context, next)
  }
}
