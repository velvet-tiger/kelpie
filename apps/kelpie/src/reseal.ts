import {
  ConfigurationError,
  connectDatabase,
  createLogger,
  createSecretCipher,
  resealStoredSecrets,
  resolveKelpieConfig,
  secretEncryptionConfigSchema,
} from '@kelpie/server'

import kelpieConfig from '../kelpie.config.ts'

/**
 * Re-seals stored secrets after `SECRET_ENCRYPTION_KEY` changes.
 *
 * The rotation procedure, in full:
 *
 *   1. Keep the current key. Add the new one as `SECRET_ENCRYPTION_KEY` and move
 *      the old value to `SECRET_ENCRYPTION_KEY_PREVIOUS`.
 *   2. Deploy. Deliveries keep signing: new secrets seal under the new key, and
 *      existing ones still open under the previous one.
 *   3. Run `npm run reseal`. It rewrites every row still sealed under the old key.
 *   4. Remove `SECRET_ENCRYPTION_KEY_PREVIOUS` and deploy again.
 *
 * Safe to run at any point, including with no previous key set, where it reports
 * that everything is already current and writes nothing.
 *
 * A script rather than a subcommand because the repository has no CLI surface
 * yet. When self-host packaging adds one, this becomes a subcommand of it and
 * the body moves across unchanged.
 */

function report(message: string): void {
  process.stdout.write(`${message}\n`)
}

function reportFatal(message: string): void {
  process.stderr.write(`${message}\n`)
}

async function reseal(): Promise<number> {
  const config = resolveKelpieConfig(kelpieConfig, process.env)
  const logger = createLogger(config.logLevel)
  const database = connectDatabase(config.databaseUrl, logger)

  // Validated here rather than trusted, so a mistyped key fails before the pass
  // opens a single row instead of reporting every row unreadable. `config.env`
  // is the same env vars, with any `env` overrides from `kelpie.config.ts`
  // applied, so a self-hoster who has locked SECRET_ENCRYPTION_KEY in code
  // still gets the same key here.
  const secretConfig = secretEncryptionConfigSchema.safeParse(config.env)

  if (!secretConfig.success) {
    await database.close()

    throw new ConfigurationError(
      secretConfig.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
    )
  }

  const hasPrevious =
    secretConfig.data.SECRET_ENCRYPTION_KEY_PREVIOUS !== undefined &&
    secretConfig.data.SECRET_ENCRYPTION_KEY_PREVIOUS.trim().length > 0

  if (!hasPrevious) {
    report('SECRET_ENCRYPTION_KEY_PREVIOUS is not set. Nothing sealed under an older key can be read.')
  }

  try {
    const outcome = await resealStoredSecrets(database.db, createSecretCipher(secretConfig.data))

    for (const column of outcome.columns) {
      report(
        `${column.label}: ${String(column.examined)} examined, ${String(column.resealed)} re-sealed, ${String(column.unreadable.length)} unreadable`,
      )

      for (const id of column.unreadable) {
        reportFatal(`  unreadable: ${id}`)
      }
    }

    if (outcome.unreadable > 0) {
      reportFatal(
        `\n${String(outcome.unreadable)} value(s) opened under neither key. They were sealed under a key that is not configured, or the rows have been altered. Nothing here can recover them: set SECRET_ENCRYPTION_KEY_PREVIOUS to the key they were sealed with and run this again, or have those records re-created.`,
      )

      return 1
    }

    report(
      outcome.resealed === 0
        ? `\nNothing to do: all ${String(outcome.examined)} value(s) are already sealed under the current key.`
        : `\nRe-sealed ${String(outcome.resealed)} of ${String(outcome.examined)} value(s). You can now remove SECRET_ENCRYPTION_KEY_PREVIOUS.`,
    )

    return 0
  } finally {
    await database.close()
  }
}

try {
  process.exit(await reseal())
} catch (error: unknown) {
  if (error instanceof ConfigurationError) {
    reportFatal(error.message)
    reportFatal('Set SECRET_ENCRYPTION_KEY, and SECRET_ENCRYPTION_KEY_PREVIOUS if you are mid-rotation.')
    process.exit(1)
  }

  throw error
}
