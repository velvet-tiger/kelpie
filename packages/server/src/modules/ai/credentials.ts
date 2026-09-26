import type { AiKeyMode } from '@kelpie/schemas'

import type { Logger } from '../../lib/logger.ts'
import { SecretDecryptionError } from '../../lib/secrets.ts'
import type { SecretCipher } from '../../lib/secrets.ts'
import type { AiSettingsRow } from './repository.ts'
import { isAiProvider, resolveAiCredentials } from './rules.ts'
import type { AiEnvironment, ResolvedAiCredentials } from './rules.ts'

/**
 * Turns a stored settings row into the credentials a run would use.
 *
 * The one place a stored key is opened. `service.ts` reads it for the
 * settings view and for intake, and `executor.ts` reads it again at run time,
 * so an admin who changes the key between the two is honoured.
 */

export interface AiCredentials extends ResolvedAiCredentials {
  /**
   * Set when the stored values cannot be used as they are: the sealed key
   * would not open, or the stored provider is not one this build knows. A
   * run refuses with this message rather than quietly falling back to the
   * deployment's key.
   */
  readonly problem: string | null
}

export interface AiCredentialResolver {
  forRow(row: AiSettingsRow | undefined): AiCredentials
}

export interface AiCredentialResolverDependencies {
  readonly keyMode: AiKeyMode
  readonly environment: AiEnvironment
  readonly cipher: SecretCipher
  readonly log: Logger
}

const UNREADABLE_KEY_MESSAGE =
  'The stored AI API key could not be decrypted. An admin must enter the key again in AI settings.'

export function createAiCredentialResolver(
  dependencies: AiCredentialResolverDependencies,
): AiCredentialResolver {
  return {
    forRow(row) {
      if (dependencies.keyMode === 'deployment' || row === undefined) {
        return { ...resolveAiCredentials(dependencies.environment, undefined), problem: null }
      }

      if (row.provider !== null && !isAiProvider(row.provider)) {
        return {
          ...resolveAiCredentials(dependencies.environment, undefined),
          problem: `The stored AI provider "${row.provider}" is not supported. An admin must choose a provider in AI settings.`,
        }
      }

      let apiKey: string | null = null
      if (row.apiKeyEncrypted !== null) {
        try {
          apiKey = dependencies.cipher.open(row.apiKeyEncrypted)
        } catch (thrown: unknown) {
          if (!(thrown instanceof SecretDecryptionError)) throw thrown
          dependencies.log.error('ai api key could not be decrypted', { workspaceId: row.workspaceId })
          return {
            ...resolveAiCredentials(dependencies.environment, {
              provider: row.provider,
              model: row.model,
              apiKey: null,
            }),
            apiKey: null,
            keySource: null,
            problem: UNREADABLE_KEY_MESSAGE,
          }
        }
      }

      return {
        ...resolveAiCredentials(dependencies.environment, {
          provider: row.provider,
          model: row.model,
          apiKey,
        }),
        problem: null,
      }
    },
  }
}
