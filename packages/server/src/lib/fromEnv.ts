import type { ZodType } from 'zod'

import type { Environment } from './config.ts'

/**
 * A marker a `kelpie.config.ts` file uses to say "read this leaf from the
 * environment." The assembly's config file is the shape and the defaults;
 * `fromEnv` marks the leaves a deployment may override without a code change.
 *
 * Every marker names an env var, the Zod schema that parses it, and optionally
 * a default. Without a default the marker is required: the env var must be set,
 * or boot fails with the other configuration problems.
 *
 * The resolver walks the config object, replaces each marker with the parsed
 * value, and returns the fully-resolved object. Nothing in the app reads
 * `process.env` for these fields after boot.
 */

const FROM_ENV_MARKER = Symbol.for('kelpie.fromEnv')

export interface FromEnvMarker<T> {
  readonly [FROM_ENV_MARKER]: true
  readonly envKey: string
  readonly schema: ZodType<T>
  readonly defaultValue: T | undefined
  readonly hasDefault: boolean
}

/** A leaf in the config file: either a literal already-typed value, or a marker. */
export type ConfigValue<T> = T | FromEnvMarker<T>

export function fromEnv<T>(envKey: string, schema: ZodType<T>): FromEnvMarker<T>
export function fromEnv<T>(envKey: string, schema: ZodType<T>, defaultValue: T): FromEnvMarker<T>
export function fromEnv<T>(envKey: string, schema: ZodType<T>, defaultValue?: T): FromEnvMarker<T> {
  const hasDefault = arguments.length >= 3

  return {
    [FROM_ENV_MARKER]: true,
    envKey,
    schema,
    defaultValue: hasDefault ? (defaultValue as T) : undefined,
    hasDefault,
  }
}

export function isFromEnvMarker(value: unknown): value is FromEnvMarker<unknown> {
  return typeof value === 'object' && value !== null && (value as Record<PropertyKey, unknown>)[FROM_ENV_MARKER] === true
}

/** One problem discovered while resolving markers. Path is the dotted field. */
export interface FromEnvProblem {
  readonly path: string
  readonly message: string
}

export interface ResolveResult<T> {
  readonly value: T | undefined
  readonly problems: readonly FromEnvProblem[]
}

/**
 * Resolves one marker against an environment.
 *
 * Missing and no default: one required problem.
 * Missing with default: the default, unvalidated. A hardcoded default is
 * trusted because the developer wrote it in the assembly file.
 * Present: parsed through the marker's schema. Parse failures become problems.
 */
export function resolveMarker<T>(marker: FromEnvMarker<T>, environment: Environment, path: string): ResolveResult<T> {
  const raw = environment[marker.envKey]

  if (raw === undefined) {
    if (marker.hasDefault) {
      return { value: marker.defaultValue, problems: [] }
    }

    return {
      value: undefined,
      problems: [{ path, message: `${marker.envKey} is required` }],
    }
  }

  const result = marker.schema.safeParse(raw)

  if (!result.success) {
    return {
      value: undefined,
      problems: result.error.issues.map((issue) => ({
        path,
        message: `${marker.envKey}: ${issue.message}`,
      })),
    }
  }

  return { value: result.data, problems: [] }
}

/**
 * Walks any value, replacing every `FromEnvMarker` with its resolved value.
 * Objects and arrays are walked recursively; other values pass through.
 *
 * Collects problems from every marker rather than throwing at the first one,
 * so a self-hoster fixes their environment once rather than a variable at a
 * time.
 */
export function resolveMarkers(
  input: unknown,
  environment: Environment,
  path = '',
): { readonly value: unknown; readonly problems: readonly FromEnvProblem[] } {
  if (isFromEnvMarker(input)) {
    return resolveMarker(input, environment, path)
  }

  if (Array.isArray(input)) {
    const problems: FromEnvProblem[] = []
    const value = input.map((item, index) => {
      const childPath = `${path}[${String(index)}]`
      const result = resolveMarkers(item, environment, childPath)
      problems.push(...result.problems)

      return result.value
    })

    return { value, problems }
  }

  if (typeof input === 'object' && input !== null) {
    const problems: FromEnvProblem[] = []
    const value: Record<string, unknown> = {}

    for (const [key, child] of Object.entries(input)) {
      const childPath = path.length > 0 ? `${path}.${key}` : key
      const result = resolveMarkers(child, environment, childPath)
      problems.push(...result.problems)
      value[key] = result.value
    }

    return { value, problems }
  }

  return { value: input, problems: [] }
}
