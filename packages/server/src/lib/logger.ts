import winston from 'winston'
import Transport from 'winston-transport'

import type { LogLevel } from './config.ts'

/**
 * Structured logging as JSON lines. Every line goes through one or more
 * transports, each of which is a named destination (`createStdoutTransport`,
 * `createCaptureTransport`, and whatever a deployment adds). Nothing defaults:
 * an empty transport list means the logger writes nowhere, which the assembly
 * must notice.
 *
 * Winston handles level filtering and fan-out to transports. The JSON line
 * itself is built in this file and passed through as the message, so the
 * envelope order (`time`, `level`, `message` last) is preserved exactly.
 */

export type LogFields = Readonly<Record<string, unknown>>

export interface Logger {
  debug(message: string, fields?: LogFields): void
  info(message: string, fields?: LogFields): void
  warn(message: string, fields?: LogFields): void
  error(message: string, fields?: LogFields): void
  /** Returns a logger that stamps `fields` onto every line, e.g. a request id. */
  child(fields: LogFields): Logger
}

/**
 * A destination declared in `kelpie.config.ts`. Extend the union to add a new
 * kind; the switch in `createTransportForDestination` fails to compile until it
 * covers every new variant, so a destination cannot be added in config without
 * a matching transport factory.
 */
export type LoggingDestination = { readonly kind: 'stdout' }

const LEVELS: Readonly<Record<LogLevel, number>> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
}

class LineTransport extends Transport {
  private readonly writeLine: (line: string) => void

  constructor(writeLine: (line: string) => void) {
    super()
    this.writeLine = writeLine
  }

  override log(info: { readonly message: string }, next: () => void): void {
    this.writeLine(info.message)
    // Winston expects the transport to emit 'logged' after handling.
    setImmediate(() => this.emit('logged', info))
    next()
  }
}

/** Writes each line plus a trailing newline directly to stdout. */
export function createStdoutTransport(): Transport {
  return new LineTransport((line) => {
    process.stdout.write(`${line}\n`)
  })
}

/** Hands each line to a callback. Tests use it to capture output. */
export function createCaptureTransport(onLine: (line: string) => void): Transport {
  return new LineTransport(onLine)
}

/**
 * Builds the transport for one declared destination. The switch is exhaustive
 * so adding a new `LoggingDestination` kind without a factory clause fails to
 * compile.
 */
export function createTransportForDestination(destination: LoggingDestination): Transport {
  switch (destination.kind) {
    case 'stdout':
      return createStdoutTransport()
  }
}

export interface CreateLoggerOptions {
  readonly level: LogLevel
  readonly transports: readonly Transport[]
  /** Injected so tests get deterministic timestamps. Defaults to the wall clock. */
  readonly now?: () => Date
}

/**
 * Builds a logger. `transports` is required: an empty list writes nowhere and
 * that is the assembly's decision to make, not a silent default.
 */
export function createLogger(options: CreateLoggerOptions): Logger {
  const now = options.now ?? ((): Date => new Date())
  const winstonLogger = winston.createLogger({
    levels: LEVELS,
    level: options.level,
    transports: [...options.transports],
  })

  function build(boundFields: LogFields): Logger {
    function emit(lineLevel: LogLevel, message: string, fields?: LogFields): void {
      // The envelope is written last so a bound or per-call field called
      // `message`, `level`, or `time` cannot overwrite it. A colliding field
      // is dropped; a corrupted envelope would make the whole line untrustworthy.
      const line = JSON.stringify({
        ...boundFields,
        ...fields,
        time: now().toISOString(),
        level: lineLevel,
        message,
      })
      // The full JSON line is passed as `message` and each transport writes it
      // verbatim. Winston still filters by level and fans out to transports;
      // it does not re-format the line.
      winstonLogger.log({ level: lineLevel, message: line })
    }

    return {
      debug: (message, fields) => emit('debug', message, fields),
      info: (message, fields) => emit('info', message, fields),
      warn: (message, fields) => emit('warn', message, fields),
      error: (message, fields) => emit('error', message, fields),
      child: (fields) => build({ ...boundFields, ...fields }),
    }
  }

  return build({})
}
