import type { ApiKey, ApiKeyGranularScope, ApiKeyKind, ApiKeyScope, CreatedApiKey } from '@kelpie/schemas'
import {
  API_KEY_DEFAULT_SCOPES,
  API_KEY_EXTRA_SCOPES,
  API_KEY_PRESET_SCOPES,
  API_KEY_SCOPE_GROUPS,
  API_KEY_SCOPE_LABELS,
  API_KEY_SCOPE_RISKS,
  expandApiKeyScopes,
  isApiKeyGranularScope,
  isApiKeyPresetScope,
} from '@kelpie/schemas'
import { useMemo, useState } from 'react'
import type { FormEvent } from 'react'

import { useTimezone } from '../api/resources/account.ts'
import { useApiKeys, useCreateApiKey, useRevokeApiKey } from '../api/resources/apiKeys.ts'
import { formatDate } from '../lib/dates.ts'
import { mcpClientConfig, mcpEndpoint } from '../lib/mcpConfig.ts'
import { CopyButton } from './CopyButton.tsx'
import { ErrorPanel, LoadingPanel } from './QueryState.tsx'

/**
 * The create/list/revoke flow shared by workspace keys (`/admin/api-keys`) and
 * personal keys (`/account/api-keys`).
 */

export interface ApiKeysPanelProps {
  readonly kind: ApiKeyKind
  readonly namePlaceholder: string
  readonly createTitle: string
  readonly emptyMessage: string
}

const PRESET_OPTIONS = API_KEY_PRESET_SCOPES.filter((scope) => scope !== 'write:all')

export function ApiKeysPanel({
  kind,
  namePlaceholder,
  createTitle,
  emptyMessage,
}: ApiKeysPanelProps): React.JSX.Element {
  const { records, isLoading, error } = useApiKeys(kind)
  const revokeApiKey = useRevokeApiKey()
  const [showModal, setShowModal] = useState(false)
  const [minted, setMinted] = useState<CreatedApiKey | null>(null)

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <button
          type="button"
          onClick={() => {
            setShowModal(true)
          }}
          className="shrink-0 rounded-md bg-accent px-3.5 py-2 text-[12px] font-semibold text-accent-fg transition hover:bg-accent-hover"
        >
          Create key
        </button>
      </div>

      {minted !== null && (
        <SecretOnce
          apiKey={minted}
          onDismiss={() => {
            setMinted(null)
          }}
        />
      )}

      {error !== null && <ErrorPanel error={error} />}

      {isLoading ? (
        <LoadingPanel label="Loading API keys…" />
      ) : (
        <ApiKeyTable
          keys={records}
          emptyMessage={emptyMessage}
          onRevoke={(id) => {
            revokeApiKey.run(id)
          }}
          isRevoking={revokeApiKey.isPending}
        />
      )}

      {revokeApiKey.error !== null && <ErrorPanel error={revokeApiKey.error} />}

      {showModal && (
        <CreateKeyModal
          kind={kind}
          title={createTitle}
          namePlaceholder={namePlaceholder}
          onCreated={(key) => {
            setShowModal(false)
            setMinted(key)
          }}
          onCancel={() => {
            setShowModal(false)
          }}
        />
      )}
    </div>
  )
}

type AccessMode = 'full' | 'presets' | 'custom'

function CreateKeyModal({
  kind,
  title,
  namePlaceholder,
  onCreated,
  onCancel,
}: {
  readonly kind: ApiKeyKind
  readonly title: string
  readonly namePlaceholder: string
  readonly onCreated: (key: CreatedApiKey) => void
  readonly onCancel: () => void
}): React.JSX.Element {
  const createApiKey = useCreateApiKey()
  const [name, setName] = useState('')
  // The form opens on the scopes the server gives a key that names none, so
  // what a person sees ticked is what a person who only clicks Create gets.
  const [accessMode, setAccessMode] = useState<AccessMode>('presets')
  const [selectedPresets, setSelectedPresets] = useState<readonly ApiKeyScope[]>(API_KEY_DEFAULT_SCOPES)
  const [selectedCustom, setSelectedCustom] = useState<readonly ApiKeyScope[]>([])
  // Apart from the presets and the custom grid: no preset includes one, so a
  // person adds it to either.
  const [selectedExtras, setSelectedExtras] = useState<readonly ApiKeyScope[]>([])
  const [showCustom, setShowCustom] = useState(false)

  const presetExpandedScopes = useMemo(
    () => expandApiKeyScopes(selectedPresets),
    [selectedPresets],
  )

  const showScopeGrid =
    (accessMode === 'custom' && showCustom) ||
    (accessMode === 'presets' && selectedPresets.length > 0)

  const chosenScopes: readonly ApiKeyScope[] =
    accessMode === 'full'
      ? []
      : [...(accessMode === 'presets' ? selectedPresets : selectedCustom), ...selectedExtras]
  // A request with no scopes gets the server's default ones. The form never
  // sends that: it would create a key that differs from what is ticked.
  const nothingChosen = accessMode !== 'full' && chosenScopes.length === 0

  function toggleExtra(scope: ApiKeyScope): void {
    setSelectedExtras((current) =>
      current.includes(scope) ? current.filter((entry) => entry !== scope) : [...current, scope],
    )
  }

  function submit(event: FormEvent): void {
    event.preventDefault()

    if (nothingChosen) {
      return
    }

    createApiKey
      .runAsync({
        name: name.trim(),
        kind,
        ...(accessMode === 'full' ? { fullAccess: true } : { scopes: chosenScopes }),
      })
      .then(onCreated)
      .catch(() => undefined)
  }

  function toggleFullAccess(): void {
    setSelectedCustom([])
    setSelectedExtras([])
    setShowCustom(false)

    if (accessMode === 'full') {
      setAccessMode('presets')
      setSelectedPresets(API_KEY_DEFAULT_SCOPES)

      return
    }

    setAccessMode('full')
    setSelectedPresets([])
  }

  function togglePreset(scope: ApiKeyScope): void {
    setAccessMode('presets')
    setSelectedCustom([])
    setShowCustom(false)
    setSelectedPresets((current) =>
      current.includes(scope) ? current.filter((entry) => entry !== scope) : [...current, scope],
    )
  }

  function toggleCustom(scope: ApiKeyScope): void {
    setAccessMode('custom')
    setSelectedPresets([])
    setSelectedCustom((current) =>
      current.includes(scope) ? current.filter((entry) => entry !== scope) : [...current, scope],
    )
  }

  function isScopeChecked(scope: ApiKeyGranularScope): boolean {
    if (accessMode === 'custom') {
      return selectedCustom.includes(scope)
    }

    if (accessMode === 'presets') {
      return presetExpandedScopes.has(scope)
    }

    return false
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 p-4">
      <div className="animate-slide-in max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-md border border-border bg-surface-raised p-5">
        <form onSubmit={submit}>
          <h2 className="text-[15px] font-semibold text-ink">{title}</h2>
          <label className="mt-4 block">
            <span className="mb-1.5 block text-[12px] font-medium">Name</span>
            <input
              value={name}
              onChange={(event) => {
                setName(event.target.value)
              }}
              placeholder={namePlaceholder}
              required
              autoFocus
              className="w-full rounded-md border border-border bg-surface px-3 py-2 text-[13px] outline-none focus:border-accent focus:ring-2 focus:ring-accent/20"
            />
          </label>

          <fieldset className="mt-4">
            <legend className="mb-2 text-[12px] font-medium text-ink">Access</legend>
            <div className="space-y-2">
              {accessMode !== 'full' && (
                <div className="rounded-md border border-border p-3">
                  <p className="mb-2 text-[11px] font-medium tracking-wide text-ink-muted uppercase">
                    Presets
                  </p>
                  <div className="space-y-1.5">
                    {PRESET_OPTIONS.map((scope) => (
                      <label key={scope} className="flex items-center gap-2 text-[13px] text-ink">
                        <input
                          type="checkbox"
                          checked={accessMode === 'presets' && selectedPresets.includes(scope)}
                          onChange={() => {
                            togglePreset(scope)
                          }}
                        />
                        {API_KEY_SCOPE_LABELS[scope]}
                      </label>
                    ))}
                  </div>
                </div>
              )}
              {(accessMode === 'custom' || (accessMode === 'presets' && selectedPresets.length === 0)) && (
                <button
                  type="button"
                  onClick={() => {
                    setShowCustom((open) => !open)
                    if (!showCustom) {
                      setAccessMode('custom')
                      setSelectedPresets([])
                    }
                  }}
                  className="text-[12px] font-medium text-accent hover:underline"
                >
                  {showCustom ? 'Hide custom scopes' : 'Custom scopes…'}
                </button>
              )}
              {showScopeGrid && (
                <div className="space-y-3 rounded-md border border-border p-3">
                  {accessMode === 'presets' && (
                    <p className="text-[11px] text-ink-muted">
                      Included in the selected preset{selectedPresets.length === 1 ? '' : 's'}.
                    </p>
                  )}
                  {API_KEY_SCOPE_GROUPS.map((group) => (
                    <div key={group.label}>
                      <p className="mb-1.5 text-[11px] font-medium tracking-wide text-ink-muted uppercase">
                        {group.label}
                      </p>
                      <div className="grid grid-cols-1 gap-1 sm:grid-cols-2">
                        {group.scopes.map((scope) => (
                          <label
                            key={scope}
                            className={`flex items-center gap-2 text-[12px] ${
                              accessMode === 'presets' ? 'text-ink-muted' : 'text-ink'
                            }`}
                          >
                            <input
                              type="checkbox"
                              checked={isScopeChecked(scope)}
                              disabled={accessMode === 'presets'}
                              onChange={() => {
                                toggleCustom(scope)
                              }}
                            />
                            {API_KEY_SCOPE_LABELS[scope]}
                          </label>
                        ))}
                      </div>
                    </div>
                  ))}
                  {accessMode === 'presets' && (
                    <button
                      type="button"
                      onClick={() => {
                        setAccessMode('custom')
                        setSelectedPresets([])
                        setSelectedCustom([...presetExpandedScopes])
                        setShowCustom(true)
                      }}
                      className="text-[12px] font-medium text-accent hover:underline"
                    >
                      Switch to custom scopes…
                    </button>
                  )}
                </div>
              )}
              {accessMode !== 'full' && (
                <div className="rounded-md border border-border p-3">
                  <p className="mb-2 text-[11px] font-medium tracking-wide text-ink-muted uppercase">
                    Extra permissions
                  </p>
                  <div className="space-y-2">
                    {API_KEY_EXTRA_SCOPES.map((scope) => (
                      <label key={scope} className="flex items-start gap-2 text-[13px] text-ink">
                        <input
                          type="checkbox"
                          className="mt-0.5"
                          checked={selectedExtras.includes(scope)}
                          onChange={() => {
                            toggleExtra(scope)
                          }}
                        />
                        <span>
                          {API_KEY_SCOPE_LABELS[scope]}
                          <span className="block text-[11px] text-ink-muted">{API_KEY_SCOPE_RISKS[scope]}</span>
                        </span>
                      </label>
                    ))}
                  </div>
                </div>
              )}
              <div className="rounded-md border border-warning/40 bg-warning-soft p-3">
                <label className="flex items-center gap-2 text-[13px] font-medium text-ink">
                  <input type="checkbox" checked={accessMode === 'full'} onChange={toggleFullAccess} />
                  Full access
                </label>
                <p className="mt-1 text-[11px] text-warning">
                  A full-access key can do everything your role can in this workspace: delete records,
                  change the handbook, and manage members, keys and webhooks. Choose it only for a
                  program that you control completely.
                </p>
              </div>
            </div>
            <p className="mt-2 text-[11px] text-ink-faint">
              {nothingChosen
                ? 'Choose at least one permission, or full access.'
                : 'Write includes read for the same resource, and does not include delete. Presets cover many scopes at once. No preset includes an extra permission.'}
            </p>
          </fieldset>

          {createApiKey.error !== null && (
            <div className="mt-3">
              <ErrorPanel error={createApiKey.error} />
            </div>
          )}

          <div className="mt-4 flex justify-end gap-2">
            <button
              type="button"
              onClick={onCancel}
              className="rounded-md px-3 py-2 text-[12px] font-medium text-ink-muted hover:text-ink"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={createApiKey.isPending || nothingChosen}
              className="rounded-md bg-accent px-3.5 py-2 text-[12px] font-semibold text-accent-fg hover:bg-accent-hover disabled:opacity-50"
            >
              {createApiKey.isPending ? 'Creating…' : 'Create'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

function SecretOnce({
  apiKey,
  onDismiss,
}: {
  readonly apiKey: CreatedApiKey
  readonly onDismiss: () => void
}): React.JSX.Element {
  const endpoint = mcpEndpoint()
  const config = mcpClientConfig(endpoint, apiKey.secret)

  return (
    <div className="rounded-md border border-accent/40 bg-accent-soft px-4 py-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[13px] font-medium text-ink">Copy this key now. It is not shown again.</p>
          <code className="mt-2 block break-all rounded border border-border bg-surface px-3 py-2 font-mono text-[12px] text-ink">
            {apiKey.secret}
          </code>
        </div>
        <CopyButton value={apiKey.secret} label="Copy the API key" />
      </div>
      <div className="mt-4 flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-medium text-ink">MCP client config</p>
          <p className="mt-0.5 text-[12px] text-ink-muted">
            Paste into Claude, Cursor, or any MCP client. It connects to{' '}
            <code className="font-mono text-[12px] break-all">{endpoint}</code> with this key.
          </p>
          <pre className="bg-code-bg text-code-fg mt-2 overflow-x-auto rounded border border-border p-3 font-mono text-[12px] leading-relaxed">
            {config}
          </pre>
        </div>
        <CopyButton value={config} label="Copy the MCP client config" />
      </div>
      <button
        type="button"
        onClick={onDismiss}
        className="mt-2 text-[12px] font-medium text-accent hover:underline"
      >
        I have copied it
      </button>
    </div>
  )
}

function formatScopeSummary(scopes: readonly ApiKeyScope[]): string {
  if (scopes.length === 0) {
    return 'Full access'
  }

  const extraScopes: readonly ApiKeyScope[] = API_KEY_EXTRA_SCOPES
  const presets = scopes.filter(isApiKeyPresetScope)
  // An extra permission is named, never counted into "Custom": it changes
  // what the key may do on its own authority, and a count would hide it.
  const extras = scopes.filter((scope) => extraScopes.includes(scope))
  const granular = scopes.filter((scope) => isApiKeyGranularScope(scope) && !extraScopes.includes(scope))
  const custom =
    presets.length === 0 ? `Custom (${String(granular.length)} scopes)` : `Custom (${String(granular.length)})`

  return [
    ...presets.map((scope) => API_KEY_SCOPE_LABELS[scope]),
    ...(granular.length === 0 ? [] : [custom]),
    ...extras.map((scope) => API_KEY_SCOPE_LABELS[scope]),
  ].join(', ')
}

function ApiKeyTable({
  keys,
  emptyMessage,
  onRevoke,
  isRevoking,
}: {
  readonly keys: readonly ApiKey[]
  readonly emptyMessage: string
  readonly onRevoke: (id: string) => void
  readonly isRevoking: boolean
}): React.JSX.Element {
  if (keys.length === 0) {
    return (
      <p className="rounded-md border border-border px-4 py-10 text-center text-[13px] text-ink-faint">
        {emptyMessage}
      </p>
    )
  }

  return (
    <div className="overflow-x-auto rounded-md border border-border">
      <table className="w-full text-left text-[13px]">
        <thead>
          <tr className="border-b border-border bg-surface text-[11px] font-semibold tracking-wide text-ink-muted uppercase">
            <th className="px-4 py-2.5">Name</th>
            <th className="px-4 py-2.5">Scopes</th>
            <th className="px-4 py-2.5">Prefix</th>
            <th className="px-4 py-2.5">Created</th>
            <th className="px-4 py-2.5">Last used</th>
            <th className="px-4 py-2.5 text-right">Actions</th>
          </tr>
        </thead>
        <tbody>
          {keys.map((key) => (
            <ApiKeyRow key={key.id} apiKey={key} onRevoke={onRevoke} isRevoking={isRevoking} />
          ))}
        </tbody>
      </table>
    </div>
  )
}

function ApiKeyRow({
  apiKey,
  onRevoke,
  isRevoking,
}: {
  readonly apiKey: ApiKey
  readonly onRevoke: (id: string) => void
  readonly isRevoking: boolean
}): React.JSX.Element {
  const [isConfirming, setIsConfirming] = useState(false)
  const timezone = useTimezone()

  return (
    <tr className="border-b border-border last:border-0">
      <td className="px-4 py-3 font-medium">{apiKey.name}</td>
      <td className="px-4 py-3 text-ink-muted">{formatScopeSummary(apiKey.scopes)}</td>
      <td className="px-4 py-3 font-mono text-[12px] text-ink-muted">{apiKey.displayPrefix}</td>
      <td className="px-4 py-3 text-ink-muted">{formatDate(apiKey.createdAt, timezone)}</td>
      <td className="px-4 py-3 text-ink-muted">
        {apiKey.lastUsedAt === null ? 'Never' : formatDate(apiKey.lastUsedAt, timezone)}
      </td>
      <td className="px-4 py-3 text-right">
        {isConfirming ? (
          <span className="inline-flex items-center gap-3">
            <button
              type="button"
              onClick={() => {
                setIsConfirming(false)
              }}
              className="text-[12px] font-medium text-ink-muted hover:text-ink"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={isRevoking}
              onClick={() => {
                onRevoke(apiKey.id)
              }}
              className="text-[12px] font-medium text-danger hover:underline disabled:opacity-50"
            >
              {isRevoking ? 'Revoking…' : 'Revoke'}
            </button>
          </span>
        ) : (
          <button
            type="button"
            onClick={() => {
              setIsConfirming(true)
            }}
            className="text-[12px] font-medium text-danger hover:underline"
          >
            Revoke
          </button>
        )}
      </td>
    </tr>
  )
}
