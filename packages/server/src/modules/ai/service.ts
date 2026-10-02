import { AI_SERVICE_LABELS, isRecordReferenceType } from '@kelpie/schemas'
import type { AiKeyMode, AiKeySource, AiProvider, AiService as AiServiceName, RecordReference } from '@kelpie/schemas'

import { AppError } from '../../lib/errors.ts'
import type { IdFactory } from '../../lib/ids.ts'
import type { JobHandle } from '../../lib/jobs.ts'
import type { Logger } from '../../lib/logger.ts'
import { readListWindow, toPage } from '../../lib/pagination.ts'
import type { ListQueryParameters, Page } from '../../lib/pagination.ts'
import type { SecretCipher } from '../../lib/secrets.ts'
import type { Database } from '../../lib/database.ts'
import { limitFor } from '../../runtime/entitlements.ts'
import type { EntitlementRegistry } from '../../runtime/entitlements.ts'
import type { TransactionScope } from '../../runtime/transaction.ts'
import { actorWorkspaceId } from '../auth/actor.ts'
import { resolveReferences } from '../recordReferences.ts'
import type { ReferenceTarget } from '../recordReferences.ts'
import { targetKey } from '../recordTargets.ts'
import type { Actor } from '../auth/actor.ts'
import { roleAllows } from '../workspace/roles.ts'
import type { AiCredentialResolver, AiCredentials } from './credentials.ts'
import type { AiDrainJobData } from './drainJob.ts'
import type { IdFactory as AiIdFactory } from './ids.ts'
import {
  countRunsSince,
  deleteRuns,
  deleteSettings,
  findRun,
  findSettings,
  insertRunIfNew,
  insertRunningRun,
  listRuns,
  DEFAULT_RUN_SORT,
  RUN_SORTS,
  trimRuns,
  upsertSettings,
} from './repository.ts'
import type { AiRunSettler } from './settle.ts'
import type { OperationOutcome } from './proposal.ts'
import type { AiRunRecord, AiSettingsRow, SettleRunInput } from './repository.ts'
import {
  AI_RUNS_LIMIT,
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

const STALE_RUN_REASON = 'The run exceeded AI_RUN_TIMEOUT_MINUTES and was abandoned'
const OVER_LIMIT_MESSAGE = 'This workspace has used its monthly AI runs'

const NOT_CONFIGURED_MESSAGE: Readonly<Record<AiKeyMode, string>> = {
  deployment:
    'AI is not configured on this deployment; the operator can set AI_PROVIDER and AI_API_KEY to enable it',
  workspace: 'Choose a provider and enter an API key in AI settings before you enable AI',
}

const DEPLOYMENT_MANAGED_MESSAGE =
  'This deployment manages the AI provider, key and model; the settings body may carry only web_search'

export interface AiServiceDependencies {
  readonly db: Database
  readonly transaction: TransactionScope
  /** Ends runs and reports each as `ai.run.settled`. */
  readonly settler: AiRunSettler
  readonly cipher: SecretCipher
  readonly credentials: AiCredentialResolver
  /** Which AI service this install offers. Names the Run menu's agent row. */
  readonly serviceName: AiServiceName
  readonly keyMode: AiKeyMode
  readonly coreCreateId: IdFactory
  readonly createRunId: AiIdFactory
  readonly entitlements: EntitlementRegistry
  /** Enqueued with each new run; its handler is what executes the run. */
  readonly drainJob: JobHandle<AiDrainJobData>
  readonly now: () => Date
  readonly runTimeoutMinutes: number
  /** `AI_RUN_LOG_LIMIT`. A workspace's own `run_log_limit` overrides it. */
  readonly runLogLimit: number
  readonly log: Logger
}

export interface AiSettingsView {
  readonly service: AiServiceName
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
  readonly webSearch: boolean
}

/**
 * `POST /v1/ai/settings`, parsed. `undefined` keeps the stored value, `null`
 * clears it. Always empty in `deployment` key mode.
 */
export interface AiSettingsChanges {
  readonly provider?: AiProvider
  readonly apiKey?: string | null
  readonly model?: string | null
  /** Either key mode. */
  readonly webSearch?: boolean
}

/** A synchronous run the caller drives itself: the row, and what to run it with. */
export interface AiSyncRun {
  readonly run: AiRunRecord
  readonly model: string
  readonly webSearch: boolean
}

/** An operation as the run log shows it: its outcome plus the records its detail cites. */
export interface AiOperationView extends OperationOutcome {
  readonly references: readonly RecordReference[]
}

/**
 * A run as the API returns one: the stored row, plus the name of the record it
 * ran on and the records each operation's detail cites. A `workspace` target
 * has no name: the log shows the task alone.
 */
export interface AiRunView extends Omit<AiRunRecord, 'operations'> {
  readonly targetName: string | null
  readonly operations: readonly AiOperationView[] | null
}

/**
 * The record a run's target names, as a citation. `handbook` is a handbook page.
 * A `workspace` target is not named: the log shows the task alone.
 */
function runTarget(run: AiRunRecord): ReferenceTarget | undefined {
  const targetType = run.targetType === 'handbook' ? 'handbook_page' : run.targetType

  return isRecordReferenceType(targetType)
    ? { targetType, targetId: run.targetId }
    : undefined
}

/** Names every run's target and each operation's cited records in one lookup for the page. */
async function toRunViews(db: Database, workspaceId: string, runs: readonly AiRunRecord[]): Promise<AiRunView[]> {
  const { names, referencesIn } = await resolveReferences(
    db,
    workspaceId,
    runs.flatMap((run) => (run.operations ?? []).map((operation) => operation.detail)),
    runs.flatMap((run) => {
      const target = runTarget(run)

      return target === undefined ? [] : [target]
    }),
  )

  return runs.map((run) => {
    const target = runTarget(run)

    return {
      ...run,
      targetName: target === undefined ? null : (names.get(targetKey(target)) ?? null),
      operations:
        run.operations === null
          ? null
          : run.operations.map((operation) => ({ ...operation, references: referencesIn(operation.detail) })),
    }
  })
}

/**
 * The `context` bag core sends on dispatch. Loose on purpose — new keys pass
 * through — but the fields the context-pack builder reads are named so
 * `dispatch.ts` and this file agree on the shape.
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
   * it is on already, and upserts the registration. Re-posting repairs the
   * registration row.
   */
  enable(actor: Actor, changes: AiSettingsChanges): Promise<AiSettingsView>
  /** Disables the module and forgets any stored key; run history is kept. */
  disable(actor: Actor): Promise<void>
  /** What the admin AI page reads. */
  view(actor: Actor): Promise<AiSettingsView>
  listRuns(actor: Actor, query: ListQueryParameters): Promise<Page<AiRunView>>
  getRun(actor: Actor, id: string): Promise<AiRunView>
  /**
   * Queues a dispatched run. Called only by the in-process dispatcher, so
   * there is no credential to check. Answers void on success; throws
   * AppError otherwise.
   */
  accept(payload: DispatchPayload): Promise<void>
  /**
   * Admits and records a run the caller makes itself, such as a person-intake
   * call. The same checks as `accept`: enabled, configured, under the monthly
   * limit. The row starts `running`; the caller must settle it.
   */
  startSyncRun(workspaceId: string, taskId: string, prompt: string): Promise<AiSyncRun>
  settleSyncRun(workspaceId: string, runId: string, changes: SettleRunInput): Promise<void>
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
    dispatchSecretEncrypted: null,
    provider: changes.provider ?? stored?.provider ?? null,
    model: changes.model === undefined ? keptModel : changes.model,
    apiKeyEncrypted:
      changes.apiKey === undefined ? keptKey : changes.apiKey === null ? null : (sealedNewKey ?? null),
    webSearch: changes.webSearch ?? stored?.webSearch ?? true,
    runLogLimit: stored?.runLogLimit ?? null,
    createdAt: stored?.createdAt ?? now,
    updatedAt: stored?.updatedAt ?? now,
  }
}

export function createAiService(dependencies: AiServiceDependencies): AiService {
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
      service: dependencies.serviceName,
      keyMode: dependencies.keyMode,
      configured: isUsable(credentials),
      enabled: settings !== undefined,
      provider: credentials.provider,
      model: credentials.model,
      keySource: credentials.keySource,
      keyHint: credentials.keySource === 'workspace' ? keyHint(credentials.apiKey) : null,
      monthlyLimit,
      runsThisMonth,
      webSearch: settings?.webSearch ?? true,
    }
  }

  /**
   * The checks every run passes before it is recorded, queued or synchronous.
   * Answers the credentials the run will use; throws `AppError` otherwise.
   */
  async function admit(workspaceId: string, now: Date): Promise<{ credentials: AiCredentials; settings: AiSettingsRow }> {
    // A row left behind by a disable that did not reach the registration,
    // or a dispatch that raced a disable. Say so on the run.
    const settings = await findSettings(dependencies.db, workspaceId)

    if (settings === undefined) {
      throw AppError.conflict('AI is not enabled for this workspace; an admin can enable it in AI settings')
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

    // Stale sweep before the capacity decision, so a crashed executor can
    // never wedge a workspace's queue forever. Inline, per the "no
    // scheduler" doctrine.
    const swept = await dependencies.settler.sweepStale(
      workspaceId,
      staleBefore(now, dependencies.runTimeoutMinutes),
      STALE_RUN_REASON,
    )
    if (swept > 0) {
      dependencies.log.warn('ai stale runs swept', { workspaceId, count: swept })
    }

    // Retention, inline for the same reason as the sweep. The month window
    // is spared so the cap check below still counts every run this month.
    const trimmed = await trimRuns(
      dependencies.db,
      workspaceId,
      settings.runLogLimit ?? dependencies.runLogLimit,
      monthWindowStart(now),
    )
    if (trimmed > 0) {
      dependencies.log.info('ai run log trimmed', { workspaceId, count: trimmed })
    }

    // Metering: monthly run cap. Over the cap answers 403, which core's
    // dispatch engine records on the visible agent_run as the failure
    // reason the user sees. Unlimited unless the assembly provides a limit.
    const monthlyLimit = await limitFor(dependencies.entitlements, workspaceId, AI_RUNS_LIMIT.name)
    if (monthlyLimit !== null) {
      const runsThisMonth = await countRunsSince(dependencies.db, workspaceId, monthWindowStart(now))
      if (runsThisMonth >= monthlyLimit) {
        throw new AppError('entitlement_required', OVER_LIMIT_MESSAGE)
      }
    }

    return { credentials, settings }
  }

  return {
    async enable(actor, changes) {
      requireAdmin(actor)
      const workspaceId = requireWorkspace(actor)
      const hasKeyChanges =
        changes.provider !== undefined || changes.apiKey !== undefined || changes.model !== undefined

      if (dependencies.keyMode === 'deployment' && hasKeyChanges) {
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

      const now = dependencies.now()

      await dependencies.transaction(async ({ tx }) => {
        await upsertSettings(
          tx,
          {
            workspaceId,
            ...(dependencies.keyMode === 'workspace'
              ? { provider: next.provider, model: next.model, apiKeyEncrypted: next.apiKeyEncrypted }
              : {}),
            ...(changes.webSearch === undefined ? {} : { webSearch: changes.webSearch }),
          },
          now,
        )
        await ensureKelpieRegistration(
          tx,
          dependencies.coreCreateId,
          workspaceId,
          AI_SERVICE_LABELS[dependencies.serviceName],
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

    async listRuns(actor, query) {
      const workspaceId = requireWorkspace(actor)
      const window = readListWindow(query, RUN_SORTS, DEFAULT_RUN_SORT)
      const rows = await listRuns(dependencies.db, workspaceId, window)
      const page = toPage(rows, window, (run) => run.id)

      return { ...page, items: await toRunViews(dependencies.db, workspaceId, page.items) }
    },

    async getRun(actor, id) {
      const workspaceId = requireWorkspace(actor)
      const run = await findRun(dependencies.db, workspaceId, id)

      if (run === undefined) {
        throw AppError.notFound('No AI run has that id')
      }

      const [view] = await toRunViews(dependencies.db, workspaceId, [run])

      if (view === undefined) {
        throw new Error('toRunViews returned no view for one run')
      }

      return view
    },

    async accept(payload) {
      const now = dependencies.now()
      const { credentials } = await admit(payload.workspaceId, now)

      // Idempotent upsert: the same run_id delivered twice records once. The
      // job commits with the row, so a recorded run always has a job to start
      // it, and a rolled-back insert leaves no job behind.
      const inserted = await dependencies.transaction(async ({ tx, jobs }) => {
        const run = await insertRunIfNew(
          tx,
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

        if (run !== undefined) {
          await jobs.enqueue(dependencies.drainJob, { workspaceId: payload.workspaceId })
        }

        return run
      })

      if (inserted === undefined) {
        // A redelivery. The first run is already recorded and its job is
        // either waiting, running or done; nothing to enqueue.
        dependencies.log.info('ai dispatch redelivered', { agentRunId: payload.runId })
      }

      // The route answers 202 whether the run starts at once or waits behind
      // the concurrency cap. The job's worker executes it.
    },

    async startSyncRun(workspaceId, taskId, prompt) {
      const now = dependencies.now()
      const { credentials, settings } = await admit(workspaceId, now)
      const run = await insertRunningRun(
        dependencies.db,
        {
          id: dependencies.createRunId(),
          workspaceId,
          taskId,
          targetType: 'workspace',
          targetId: workspaceId,
          model: credentials.model,
          prompt,
        },
        now,
      )

      return { run, model: credentials.model, webSearch: settings.webSearch }
    },

    async settleSyncRun(workspaceId, runId, changes) {
      await dependencies.settler.settle(workspaceId, runId, changes)
    },

    async forget(workspaceId) {
      await Promise.all([
        deleteRuns(dependencies.db, workspaceId),
        deleteSettings(dependencies.db, workspaceId),
      ])
    },
  }
}
