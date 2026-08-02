import type { LogLevel } from './config.ts'

/**
 * Structured logging as JSON lines. The sink is injected so tests capture output
 * instead of writing to stdout, and so a deployment can redirect it.
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

export type LogSink = (line: string) => void

const severityByLevel: Readonly<Record<LogLevel, number>> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
}

function writeToStdout(line: string): void {
  process.stdout.write(`${line}\n`)
}

/**
 * @param level Minimum level to emit. Lines below it are dropped.
 * @param sink Receives one complete JSON line per log call.
 * @param now Injected so tests get deterministic timestamps.
 */
export function createLogger(
  level: LogLevel,
  sink: LogSink = writeToStdout,
  now: () => Date = () => new Date(),
): Logger {
  const threshold = severityByLevel[level]

  function build(boundFields: LogFields): Logger {
    function emit(lineLevel: LogLevel, message: string, fields?: LogFields): void {
      if (severityByLevel[lineLevel] < threshold) {
        return
      }
      sink(
        JSON.stringify({
          time: now().toISOString(),
          level: lineLevel,
          message,
          ...boundFields,
          ...fields,
        }),
      )
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
