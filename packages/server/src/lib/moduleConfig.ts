import { readFileSync } from 'node:fs'

import { z } from 'zod'

/**
 * Reads `modules.md`'s deploy-time module override file, the mechanism a
 * self-hoster uses to lock a module on or off for every workspace the process
 * serves, ahead of whatever a workspace's own settings screen would otherwise
 * decide (`runtime/moduleConfig.ts` is where that override wins).
 *
 * Shape:
 * ```json
 * { "modules": { "raises": false, "hiring": false } }
 * ```
 */

const moduleConfigFileSchema = z.object({
  modules: z.record(z.string(), z.boolean()),
})

/** Thrown when a configured path exists but does not hold a valid module config file. */
export class ModuleConfigFileError extends Error {
  constructor(path: string, reason: string) {
    super(`${path} is not a valid module config file: ${reason}`)
    this.name = 'ModuleConfigFileError'
  }
}

/**
 * @param path Absolute or relative path, normally `KELPIE_MODULE_CONFIG_PATH`.
 *   Undefined when the deployment sets no path, which is the ordinary case: a
 *   workspace's own settings decide instead.
 * @returns The module id to enabled map the file declares, or undefined when no
 *   path was given.
 * @throws ModuleConfigFileError if a given path cannot be read or parsed.
 */
export function readModuleConfigFile(path: string | undefined): Readonly<Record<string, boolean>> | undefined {
  if (path === undefined) {
    return undefined
  }

  let raw: string

  try {
    raw = readFileSync(path, 'utf8')
  } catch (error: unknown) {
    throw new ModuleConfigFileError(path, error instanceof Error ? error.message : String(error))
  }

  let parsed: unknown

  try {
    parsed = JSON.parse(raw)
  } catch (error: unknown) {
    throw new ModuleConfigFileError(path, error instanceof Error ? error.message : String(error))
  }

  const result = moduleConfigFileSchema.safeParse(parsed)

  if (!result.success) {
    throw new ModuleConfigFileError(path, result.error.issues.map((issue) => issue.message).join('; '))
  }

  return result.data.modules
}
