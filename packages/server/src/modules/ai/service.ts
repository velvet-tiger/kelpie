import { timingSafeEqual } from 'node:crypto'

import type { AiKeyMode, AiKeySource, AiProvider } from '@kelpie/schemas'

import { AppError } from '../../lib/errors.ts'
import type { IdFactory } from '../../lib/ids.ts'
import type { Logger } from '../../lib/logger.ts'
import { SecretDecryptionError } from '../../lib/secrets.ts'
import type { SecretCipher } from '../../lib/secrets.ts'
import { generateToken } from '../../lib/tokens.ts'
import type { Database } from '../../lib/database.ts'
import { limitFor } from '../../runtime/entitlements.ts'
import type { EntitlementRegistry } from '../../runtime/entitlements.ts'
import type { TransactionScope } from '../../runtime/transaction.ts'
import { actorWorkspaceId } from '../auth/actor.ts'
import type { Actor } from '../auth/actor.ts'
import { roleAllows } from '../workspace/roles.ts'
import type { AiCredentialResolver, AiCredentials } from './credentials.ts'
import type { AiExecutor } from './executor.ts'
import type { IdFactory as AiIdFactory } from './ids.ts'
import {
  countRunsSince,
  deleteRuns,
  deleteSettings,
  findRun,
  findSettings,
  insertRunIfNew,
  listRuns,
  sweepStaleRuns,
  upsertSettings,
} from './repository.ts'
import type { AiRunRecord, AiSettingsRow } from './repository.ts'
import {
  AI_RUNS_LIMIT,
  dispatchEndpointFor,
  keyHint,
  monthWindowStart,
  staleBefore,
} from './rules.ts'
import {
  ensureKelpieRegistration,
  removeKelpieRegistration,
} from './registration.ts'

/**
 * The AI module's whole seam between the routes (which parse HTTP) and the
 * repositories (which run SQL). The provider SDKs sit behind
 * `AiProviderPort`, so a test drives every path here without a network round
 * trip.
 *
 * **Two key modes.** In `workspace` mode an admin chooses the provider, the
 * key and the model, and the deployment's `AI_*` environment is a fallback.
 * In `deployment` mode the environment is the whole answer and the settings
 * body must be empty. Either way the same run limit applies, and it answers
 * unlimited unless something in the assembly provides a number.
 */

const DISPATCH_SECRET_PREFIX = 'aidsp_'
const RUN_LIST_LIMIT = 50

const STALE_RUN_REASON = 'The run exceeded AI_RUN_TIMEOUT_MINUTES and was abandoned'
const OVER_LIMIT_MESSAGE = 'This workspace has used its monthly AI runs'

const NOT_CONFIGURED_MESSAGE: Readonly<Record<AiKeyMode, string>> = {
  deployment:
    'AI is not configured on this deployment; the operator can set AI_PROVIDER and AI_API_KEY to enable it',
  workspace: 'Choose a provider and enter an API key in AI settings before you enable AI',
}

const DEPLOYMENT_MANAGED_MESSAGE =
  'This deployment manages the AI provider, key and model; the settings body must be empty'

export interface AiServiceDependencies {
  readonly db: Database
  readonly transaction: TransactionScope
  readonly cipher: SecretCipher
  readonly credentials: AiCredentialResolver
  readonly keyMode: AiKeyMode
  readonly coreCreateId: IdFactory
  readonly createRunId: AiIdFactory
  readonly entitlements: EntitlementRegistry
  readonly executor: AiExecutor
  readonly now: () => Date
  readonly appBaseUrl: string
  readonly runTimeoutMinutes: number
  readonly log: Logger
}

export interface AiSettingsView {
  readonly keyMode: AiKeyMode
  /** True when a run could start now: a provider and a usable key. */
  readonly configured: boolean
  readonly enabled: boolean
  readonly provider: AiProvider | null
  readonly model: string
  readonly keySource: AiKeySource | null
  readonly keyHint: string | null
  readonly monthlyLimit: number | null
  readonly runsThisMonth: number
  readonly endpoint: string
}

/**
 * `POST /v1/ai/settings`, parsed. `undefined` keeps the stored value, `null`
 * clears it. Always empty in `deployment` key mode.
 */
export interface AiSettingsChanges {
  readonly provider?: AiProvider
  readonly apiKey?: string | null
  readonly model?: string | null
}

export interface AiRunView extends AiRunRecord {}

/**
 * The `context` bag core sends on dispatch. Loose on purpose — new keys pass
 * through — but the fields the context-pack builder reads are named so
 * `publicRoutes.ts` and this file agree on the wire shape.
 */
export interface DispatchContext {
  readonly target_label?: string
  readonly deep_link?: string
  readonly handbook_slugs?: readonly string[]
  readonly pinned_note_ids?: readonly string[]
  readonly open_plan_ids?: readonly string[]
  readonly open_decision_ids?: readonly string[]
  readonly related?: Readonly<Record<string, readonly string[]>>
  readonly [key: string]: unknown
}

export interface DispatchPayload {
  readonly runId: string
  readonly workspaceId: string
  readonly taskId: string
  readonly targetType: string
  readonly targetId: string
  readonly prompt: string
  readonly context: DispatchContext
}

export interface AiService {
  /**
   * Enables the module for the actor's workspace, or saves new settings when
   * it is on already, and upserts the registration. Re-posting rotates the
   * dispatch secret, which doubles as the repair verb.
   */
  enable(actor: Actor, changes: AiSettingsChanges): Promise<AiSettingsView>
  /** Disables the module and forgets any stored key; run history is kept. */
  disable(actor: Actor): Promise<void>
  /** What the admin AI page reads. */
  view(actor: Actor): Promise<AiSettingsView>
  listRuns(actor: Actor): Promise<readonly AiRunView[]>
  getRun(actor: Actor, id: string): Promise<AiRunView>
  /** The dispatch intake path. Answers void on success; throws AppError otherwise. */
  intake(payload: DispatchPayload, authorizationHeader: string | undefined): Promise<void>
  /** Removes every row this module holds for the workspace. Idempotent. */
  forget(workspaceId: string): Promise<void>
}

function requireWorkspace(actor: Actor): string {
  const workspaceId = actorWorkspaceId(actor)

  if (workspaceId === null) {
    throw AppError.notFound('This session has no workspace')
  }

  return workspaceId
}

function requireAdmin(actor: Actor): void {
  if (actor.role === null || !roleAllows(actor.role, 'admin')) {
    throw new AppError('forbidden', 'This action needs the admin role')
  }
}

function constantTimeStringEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, 'utf8')
  const rightBytes = Buffer.from(right, 'utf8')

  if (leftBytes.length !== rightBytes.length) {
    return false
  }

  return timingSafeEqual(leftBytes, rightBytes)
}

function isUsable(credentials: AiCredentials): boolean {
  return credentials.problem === null && credentials.provider !== null && credentials.apiKey !== null
}

/**
 * The row the settings would become, before anything is written.
 *
 * Changing provider drops the stored key and model unless the same request
 * sends new ones: a key or a model for one provider means nothing to another.
 */
function prospectiveRow(
  workspaceId: string,
  stored: AiSettingsRow | undefined,
  changes: AiSettingsChanges,
  sealedNewKey: string | undefined,
): AiSettingsRow {
  const providerChanged = changes.provider !== undefined && changes.provider !== stored?.provider
  const keptKey = providerChanged ? null : (stored?.apiKeyEncrypted ?? null)
  const keptModel = providerChanged ? null : (stored?.model ?? null)
  const now = new Date(0)

  return {
    workspaceId,
    dispatchSecretEncrypted: stored?.dispatchSecretEncrypted ?? '',
    provider: changes.provider ?? stored?.provider ?? null,
    model: changes.model === undefined ? keptModel : changes.model,
    apiKeyEncrypted:
      changes.apiKey === undefined ? keptKey : changes.apiKey === null ? null : (sealedNewKey ?? null),
    createdAt: stored?.createdAt ?? now,
    updatedAt: stored?.updatedAt ?? now,
  }
}

export function createAiService(dependencies: AiServiceDependencies): AiService {
  const endpoint = dispatchEndpointFor(dependencies.appBaseUrl)

  async function viewFor(workspaceId: string): Promise<AiSettingsView> {
    const settings = await findSettings(dependencies.db, workspaceId)
    const credentials = dependencies.credentials.forRow(settings)
    const monthlyLimit = await limitFor(dependencies.entitlements, workspaceId, AI_RUNS_LIMIT.name)
    const runsThisMonth = await countRunsSince(
      dependencies.db,
      workspaceId,
      monthWindowStart(dependencies.now()),
    )

    return {
      keyMode: dependencies.keyMode,
      configured: isUsable(credentials),
      enabled: settings !== undefined,
      provider: credentials.provider,
      model: credentials.model,
      keySource: credentials.keySource,
      keyHint: credentials.keySource === 'workspace' ? keyHint(credentials.apiKey) : null,
      monthlyLimit,
      runsThisMonth,
      endpoint,
    }
  }

  return {
    async enable(actor, changes) {
      requireAdmin(actor)
      const workspaceId = requireWorkspace(actor)
      const hasChanges =
        changes.provider !== undefined || changes.apiKey !== undefined || changes.model !== undefined

      if (dependencies.keyMode === 'deployment' && hasChanges) {
        throw new AppError('bad_request', DEPLOYMENT_MANAGED_MESSAGE)
      }

      const stored = await findSettings(dependencies.db, workspaceId)
      const sealedNewKey =
        typeof changes.apiKey === 'string' ? dependencies.cipher.seal(changes.apiKey) : undefined
      const next = prospectiveRow(workspaceId, stored, changes, sealedNewKey)
      const credentials = dependencies.credentials.forRow(
        dependencies.keyMode === 'workspace' ? next : undefined,
      )

      if (credentials.problem !== null) {
        throw AppError.conflict(credentials.problem)
      }
      if (!isUsable(credentials)) {
        throw AppError.conflict(NOT_CONFIGURED_MESSAGE[dependencies.keyMode])
      }

      const dispatchSecret = `${DISPATCH_SECRET_PREFIX}${generateToken()}`
      const bearerHeader = `Bearer ${dispatchSecret}`
      const now = dependencies.now()

      await dependencies.transaction(async ({ tx }) => {
        await upsertSettings(
          tx,
          {
            workspaceId,
            dispatchSecretEncrypted: dependencies.cipher.seal(bearerHeader),
            ...(dependencies.keyMode === 'workspace'
              ? { provider: next.provider, model: next.model, apiKeyEncrypted: next.apiKeyEncrypted }
              : {}),
          },
          now,
        )
        await ensureKelpieRegistration(
          tx,
          dependencies.coreCreateId,
          {
            workspaceId,
            endpoint,
            authHeaderEncrypted: dependencies.cipher.seal(bearerHeader),
          },
          now,
        )
      })

      // Never the key, and never its hint: the provider and where the key
      // came from are enough to trace a change.
      dependencies.log.info('ai enabled', {
        workspaceId,
        provider: credentials.provider,
        keySource: credentials.keySource,
      })

      return viewFor(workspaceId)
    },

    async disable(actor) {
      requireAdmin(actor)
      const workspaceId = requireWorkspace(actor)

      await dependencies.transaction(async ({ tx }) => {
        await removeKelpieRegistration(tx, workspaceId)
        await deleteSettings(tx, workspaceId)
      })

      dependencies.log.info('ai disabled', { workspaceId })
    },

    async view(actor) {
      const workspaceId = requireWorkspace(actor)

      return viewFor(workspaceId)
    },

    async listRuns(actor) {
      const workspaceId = requireWorkspace(actor)

      return listRuns(dependencies.db, workspaceId, RUN_LIST_LIMIT)
    },

    async getRun(actor, id) {
      const workspaceId = requireWorkspace(actor)
      const run = await findRun(dependencies.db, workspaceId, id)

      if (run === undefined) {
        throw AppError.notFound('No AI run has that id')
      }

      return run
    },

    async intake(payload, authorizationHeader) {
      // Auth first. Every failure answers 401 without saying why: it must not
      // be possible to tell "no such workspace" from "wrong secret".
      const settings = await findSettings(dependencies.db, payload.workspaceId)

      if (settings === undefined || authorizationHeader === undefined) {
        throw AppError.unauthorized()
      }

      let expected: string
      try {
        expected = dependencies.cipher.open(settings.dispatchSecretEncrypted)
      } catch (thrown: unknown) {
        if (thrown instanceof SecretDecryptionError) {
          dependencies.log.error('ai dispatch secret could not be decrypted', {
            workspaceId: payload.workspaceId,
          })
          throw AppError.unauthorized()
        }
        throw thrown
      }

      if (!constantTimeStringEqual(authorizationHeader, expected)) {
        throw AppError.unauthorized()
      }

      // Refuse rather than queue a run that cannot start: the key was
      // cleared from the environment, or the stored key will not open. The
      // message lands on the visible agent run as its failure reason.
      const credentials = dependencies.credentials.forRow(settings)
      if (credentials.problem !== null) {
        throw AppError.conflict(credentials.problem)
      }
      if (!isUsable(credentials)) {
        throw AppError.conflict(NOT_CONFIGURED_MESSAGE[dependencies.keyMode])
      }

      const now = dependencies.now()

      // Stale sweep before the capacity decision, so a crashed executor can
      // never wedge a workspace's queue forever. Inline, per the "no
      // scheduler" doctrine.
      const swept = await sweepStaleRuns(
        dependencies.db,
        payload.workspaceId,
        staleBefore(now, dependencies.runTimeoutMinutes),
        now,
        STALE_RUN_REASON,
      )
      if (swept > 0) {
        dependencies.log.warn('ai stale runs swept', {
          workspaceId: payload.workspaceId,
          count: swept,
        })
      }

      // Metering: monthly run cap. Over the cap answers 403, which core's
      // dispatch engine records on the visible agent_run as the failure
      // reason the user sees. Unlimited unless the assembly provides a limit.
      const monthlyLimit = await limitFor(
        dependencies.entitlements,
        payload.workspaceId,
        AI_RUNS_LIMIT.name,
      )
      if (monthlyLimit !== null) {
        const runsThisMonth = await countRunsSince(
          dependencies.db,
          payload.workspaceId,
          monthWindowStart(now),
        )
        if (runsThisMonth >= monthlyLimit) {
          throw new AppError('entitlement_required', OVER_LIMIT_MESSAGE)
        }
      }

      // Idempotent upsert: the same run_id delivered twice records once.
      const inserted = await insertRunIfNew(
        dependencies.db,
        {
          id: dependencies.createRunId(),
          workspaceId: payload.workspaceId,
          agentRunId: payload.runId,
          taskId: payload.taskId,
          targetType: payload.targetType,
          targetId: payload.targetId,
          model: credentials.model,
          prompt: payload.prompt,
          context: payload.context,
        },
        now,
      )

      if (inserted === undefined) {
        // A redelivery. The first run is already recorded and its executor is
        // either running or done; nothing to pump.
        dependencies.log.info('ai dispatch redelivered', { agentRunId: payload.runId })
        return
      }

      // Detached — the route answers 202 whether the run started or stayed
      // queued behind the concurrency cap. The pump loop chains completions.
      dependencies.executor.pump(payload.workspaceId)
    },

    async forget(workspaceId) {
      await Promise.all([
        deleteRuns(dependencies.db, workspaceId),
        deleteSettings(dependencies.db, workspaceId),
      ])
    },
  }
}
