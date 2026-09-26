import { AI_DEFAULT_MODELS, AI_PROVIDER_LABELS, AI_PROVIDERS } from '@kelpie/schemas'
import type { AiProvider, AiRun, AiSettings, AiSettingsInput } from '@kelpie/schemas'
import { useState } from 'react'
import type { FormEvent } from 'react'

import { useTimezone } from '../../api/resources/account.ts'
import { useAiRuns, useAiSettings, useDisableAi, useSaveAiSettings } from '../../api/resources/ai.ts'
import { Chip } from '../../components/Chip.tsx'
import type { ChipTone } from '../../components/Chip.tsx'
import { PageHeader } from '../../components/PageHeader.tsx'
import { ErrorPanel, LoadingPanel } from '../../components/QueryState.tsx'
import { formatRelativeTime } from '../../lib/dates.ts'

/**
 * The AI admin page at `/admin/ai`, from the optional `ai` module.
 *
 * Two parts: the settings for Kelpie AI in this workspace, and its run log.
 * Both read the same `/v1/ai/*` endpoints an agent would use.
 *
 * What the settings part shows depends on the module's key mode. In
 * `workspace` mode an admin picks a provider, pastes their own API key, and
 * may name a model. The key is write-only: the page shows its last four
 * characters and never the key. In `deployment` mode the operator's
 * environment decides all three, and the page offers only enable and disable.
 */

const STATUS_TONES: Readonly<Record<AiRun['status'], ChipTone>> = {
  queued: 'neutral',
  running: 'accent',
  succeeded: 'success',
  failed: 'danger',
}

const OPERATION_TONES: Readonly<Record<string, ChipTone>> = {
  applied: 'success',
  failed: 'danger',
  skipped: 'neutral',
}

const inputClass =
  'w-full max-w-md rounded-md border border-border bg-surface px-3 py-2 text-[13px] outline-none focus:border-accent focus:ring-2 focus:ring-accent/20'
const primaryButtonClass =
  'rounded-md bg-accent px-3.5 py-2 text-[12px] font-semibold text-accent-fg transition hover:bg-accent-hover disabled:opacity-50'
const secondaryButtonClass =
  'rounded-md border border-border px-3.5 py-2 text-[12px] font-medium text-ink transition hover:border-border-strong disabled:opacity-50'

function keyDescription(settings: AiSettings): string {
  if (settings.keySource === 'workspace') {
    return settings.keyHint === null ? 'Your key is stored.' : `Your key ending in ${settings.keyHint} is stored.`
  }
  if (settings.keySource === 'environment') {
    return 'This install supplies a key. Enter your own to use it instead.'
  }

  return 'No key is stored.'
}

/**
 * Provider, key and model for `workspace` key mode.
 *
 * Only changed fields are sent. The server keeps what is omitted, and drops the
 * stored key and model when the provider changes, so this form clears the model
 * field on a provider change to match.
 */
function WorkspaceKeyForm({ settings }: { readonly settings: AiSettings }): React.JSX.Element {
  const save = useSaveAiSettings()
  const [provider, setProvider] = useState<AiProvider>(settings.provider ?? 'openai')
  const [apiKey, setApiKey] = useState('')
  const [model, setModel] = useState(settings.provider === null ? '' : settings.model)

  const providerChanged = provider !== settings.provider
  const defaultModel = AI_DEFAULT_MODELS[provider]

  /** `undefined` keeps the stored model, `null` clears it back to the default. */
  function modelChange(): string | null | undefined {
    const trimmed = model.trim()

    if (trimmed === '') {
      // Nothing to clear when the workspace has not chosen a provider yet.
      if (settings.provider === null) return undefined
      return providerChanged || settings.model !== defaultModel ? null : undefined
    }

    return !providerChanged && trimmed === settings.model ? undefined : trimmed
  }

  function changes(): AiSettingsInput {
    const nextModel = modelChange()

    return {
      ...(providerChanged ? { provider } : {}),
      ...(apiKey.trim() === '' ? {} : { apiKey: apiKey.trim() }),
      ...(nextModel === undefined ? {} : { model: nextModel }),
    }
  }

  function submit(formEvent: FormEvent): void {
    formEvent.preventDefault()
    save
      .runAsync(changes())
      .then(() => {
        setApiKey('')
      })
      .catch(() => undefined)
  }

  return (
    <form onSubmit={submit} className="mt-4 space-y-3">
      <label className="block">
        <span className="mb-1.5 block text-[12px] font-medium text-ink">Provider</span>
        <select
          value={provider}
          onChange={(event) => {
            setProvider(event.target.value as AiProvider)
            setModel('')
          }}
          className="w-48 rounded-md border border-border bg-surface-raised px-3 py-2 text-[13px] outline-none focus:border-accent"
        >
          {AI_PROVIDERS.map((option) => (
            <option key={option} value={option}>
              {AI_PROVIDER_LABELS[option]}
            </option>
          ))}
        </select>
      </label>

      <label className="block">
        <span className="mb-1.5 block text-[12px] font-medium text-ink">API key</span>
        <input
          type="password"
          autoComplete="off"
          value={apiKey}
          onChange={(event) => {
            setApiKey(event.target.value)
          }}
          placeholder={providerChanged ? `Paste your ${AI_PROVIDER_LABELS[provider]} API key` : 'Paste a new key to replace it'}
          className={`${inputClass} font-mono`}
        />
        <span className="mt-1.5 block text-[12px] text-ink-muted">
          {providerChanged && settings.keySource === 'workspace'
            ? 'Changing provider removes the stored key.'
            : keyDescription(settings)}{' '}
          The key is stored encrypted and is never shown again.
        </span>
      </label>

      <label className="block">
        <span className="mb-1.5 block text-[12px] font-medium text-ink">Model</span>
        <input
          value={model}
          onChange={(event) => {
            setModel(event.target.value)
          }}
          placeholder={defaultModel}
          className={`${inputClass} font-mono`}
        />
        <span className="mt-1.5 block text-[12px] text-ink-muted">Leave it empty to use {defaultModel}.</span>
      </label>

      {save.error !== null && <ErrorPanel error={save.error} />}

      <div className="flex flex-wrap gap-2">
        <button type="submit" disabled={save.isPending} className={primaryButtonClass}>
          {save.isPending ? 'Saving…' : settings.enabled ? 'Save' : 'Enable AI'}
        </button>
        {settings.enabled && settings.keySource === 'workspace' && !providerChanged && (
          <button
            type="button"
            disabled={save.isPending}
            onClick={() => {
              save.run({ apiKey: null })
            }}
            className={secondaryButtonClass}
          >
            Remove stored key
          </button>
        )}
      </div>
    </form>
  )
}

function DeploymentKeyControls({ settings }: { readonly settings: AiSettings }): React.JSX.Element {
  const save = useSaveAiSettings()

  if (!settings.configured) {
    return (
      <p className="mt-3 text-[13px] text-ink-muted">
        The operator has not set up a provider for this install. Set
        <code className="mx-1 rounded bg-surface px-1">AI_PROVIDER</code>
        and
        <code className="mx-1 rounded bg-surface px-1">AI_API_KEY</code>
        in the environment to turn on AI runs.
      </p>
    )
  }
  if (settings.monthlyLimit === 0) {
    return <p className="mt-4 text-[13px] text-ink-muted">AI runs are not included for this workspace. Your own agent still works over MCP.</p>
  }
  if (settings.enabled) {
    return <></>
  }

  return (
    <div className="mt-4 space-y-2">
      {save.error !== null && <ErrorPanel error={save.error} />}
      <button
        type="button"
        disabled={save.isPending}
        onClick={() => {
          save.run({})
        }}
        className={primaryButtonClass}
      >
        {save.isPending ? 'Saving…' : 'Enable AI'}
      </button>
    </div>
  )
}

function SettingsPanel({ settings }: { readonly settings: AiSettings }): React.JSX.Element {
  const disable = useDisableAi()

  return (
    <section className="rounded-md border border-border p-5">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-[15px] font-semibold text-ink">Kelpie AI</h2>
        <Chip tone={settings.enabled ? 'success' : 'neutral'}>{settings.enabled ? 'Enabled' : 'Not enabled'}</Chip>
      </div>
      <p className="mt-2 max-w-2xl text-[13px] leading-relaxed text-ink-muted">
        Kelpie AI runs agent tasks for you: enrichment, summaries, follow-ups and notes. It reads the record and its
        neighbours, asks the model for a reply, and applies that reply through the same tools any agent uses.
      </p>

      <dl className="mt-4 grid max-w-md grid-cols-2 gap-y-2 text-[13px]">
        {settings.provider !== null && (
          <>
            <dt className="text-ink-muted">Provider</dt>
            <dd className="text-ink">{AI_PROVIDER_LABELS[settings.provider]}</dd>
            <dt className="text-ink-muted">Model</dt>
            <dd className="font-mono text-ink">{settings.model}</dd>
          </>
        )}
        <dt className="text-ink-muted">Runs this month</dt>
        <dd className="text-ink">
          {settings.runsThisMonth}
          {settings.monthlyLimit === null ? '' : ` / ${String(settings.monthlyLimit)}`}
        </dd>
      </dl>

      {settings.keyMode === 'workspace' ? (
        <WorkspaceKeyForm
          // Remount on a saved change, so the form starts from what the server now holds.
          key={`${settings.provider ?? 'none'}:${settings.model}:${settings.keySource ?? 'none'}:${settings.keyHint ?? ''}`}
          settings={settings}
        />
      ) : (
        <DeploymentKeyControls settings={settings} />
      )}

      {settings.enabled && (
        <div className="mt-4 space-y-2 border-t border-border pt-4">
          {disable.error !== null && <ErrorPanel error={disable.error} />}
          <button
            type="button"
            disabled={disable.isPending}
            onClick={() => {
              disable.run()
            }}
            className="rounded-md border border-danger px-3.5 py-2 text-[12px] font-medium text-danger disabled:opacity-50"
          >
            {disable.isPending ? 'Disabling…' : 'Disable AI'}
          </button>
          <p className="text-[12px] text-ink-muted">
            Disabling removes Kelpie AI from the Run menu
            {settings.keySource === 'workspace' ? ' and deletes the stored key' : ''}. The run log is kept.
          </p>
        </div>
      )}
    </section>
  )
}

function RunLog(): React.JSX.Element {
  const { records: runs, isLoading, error } = useAiRuns()
  const timezone = useTimezone()

  return (
    <section className="rounded-md border border-border p-5">
      <h2 className="text-[15px] font-semibold text-ink">Run log</h2>
      {isLoading && <LoadingPanel label="Loading runs…" />}
      {error !== null && <ErrorPanel error={error} />}
      {!isLoading && error === null && runs.length === 0 && (
        <p className="mt-2 text-[13px] text-ink-muted">
          No runs yet. Start one from the Agent menu on any record page and pick <em>Kelpie AI</em>.
        </p>
      )}
      {runs.length > 0 && (
        <ul className="mt-3 flex flex-col gap-2">
          {runs.map((run) => (
            <li key={run.id} className="rounded-md border border-border bg-surface p-3">
              <div className="flex flex-wrap items-center gap-2">
                <Chip tone={STATUS_TONES[run.status]}>{run.status}</Chip>
                <span className="text-[13px] font-medium text-ink">{run.taskId}</span>
                <span className="text-[12px] text-ink-muted">
                  {run.targetType} · {run.targetId}
                </span>
                <span className="ml-auto text-[12px] text-ink-faint">{formatRelativeTime(run.createdAt, timezone)}</span>
              </div>
              <p className="mt-1 text-[12px] text-ink-muted">
                <span className="font-mono">{run.model}</span>
                {run.inputTokens !== null && run.outputTokens !== null
                  ? ` · ${String(run.inputTokens)} in · ${String(run.outputTokens)} out`
                  : ''}
              </p>
              {run.failureReason !== null && <p className="mt-2 text-[12px] text-danger">{run.failureReason}</p>}
              {run.output !== null && (
                <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap rounded bg-surface-raised p-2 text-[12px] text-ink">
                  {run.output}
                </pre>
              )}
              {run.operations !== null && run.operations.length > 0 && (
                <ul className="mt-2 flex flex-col gap-1">
                  {run.operations.map((operation, index) => (
                    <li key={`${run.id}-op-${String(index)}`} className="flex flex-wrap items-center gap-2 text-[12px]">
                      <Chip tone={OPERATION_TONES[operation.status] ?? 'neutral'}>{operation.status}</Chip>
                      <span className="font-medium text-ink">{operation.kind}</span>
                      <span className="text-ink-muted">{operation.detail}</span>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

export function AiPage(): React.JSX.Element {
  const { record: settings, isLoading, error } = useAiSettings()

  return (
    <div className="animate-slide-in mx-auto max-w-4xl space-y-6">
      <PageHeader title="AI" description="Run agent tasks with your own model provider." />
      {isLoading && <LoadingPanel label="Loading AI settings…" />}
      {error !== null && <ErrorPanel error={error} />}
      {settings !== undefined && <SettingsPanel settings={settings} />}
      <RunLog />
    </div>
  )
}
