import type { ApiKey, ApiKeyGranularScope, ApiKeyKind, ApiKeyScope, CreatedApiKey } from '@kelpie/schemas'
import {
  API_KEY_PRESET_SCOPES,
  API_KEY_SCOPE_GROUPS,
  API_KEY_SCOPE_LABELS,
  expandApiKeyScopes,
  isApiKeyGranularScope,
  isApiKeyPresetScope,
} from '@kelpie/schemas'
import { useMemo, useState } from 'react'
import type { FormEvent } from 'react'

import { useTimezone } from '../api/resources/account.ts'
import { useApiKeys, useCreateApiKey, useRevokeApiKey } from '../api/resources/apiKeys.ts'
import { formatDate } from '../lib/dates.ts'
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
  const [accessMode, setAccessMode] = useState<AccessMode>('full')
  const [selectedPresets, setSelectedPresets] = useState<readonly ApiKeyScope[]>([])
  const [selectedCustom, setSelectedCustom] = useState<readonly ApiKeyScope[]>([])
  const [showCustom, setShowCustom] = useState(false)

  const presetExpandedScopes = useMemo(
    () => expandApiKeyScopes(selectedPresets),
    [selectedPresets],
  )

  const showScopeGrid =
    (accessMode === 'custom' && showCustom) ||
    (accessMode === 'presets' && selectedPresets.length > 0)

  function scopesForCreate(): readonly ApiKeyScope[] | undefined {
    if (accessMode === 'full') {
      return undefined
    }

    if (accessMode === 'presets') {
      return selectedPresets.length === 0 ? undefined : selectedPresets
    }

    return selectedCustom.length === 0 ? undefined : selectedCustom
  }

  function submit(event: FormEvent): void {
    event.preventDefault()
    const scopes = scopesForCreate()

    createApiKey
      .runAsync({
        name: name.trim(),
        kind,
        ...(scopes === undefined ? {} : { scopes }),
      })
      .then(onCreated)
      .catch(() => undefined)
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
              <label className="flex items-center gap-2 text-[13px] text-ink">
                <input
                  type="radio"
                  name="access"
                  checked={accessMode === 'full'}
                  onChange={() => {
                    setAccessMode('full')
                    setSelectedPresets([])
                    setSelectedCustom([])
                    setShowCustom(false)
                  }}
                />
                Full access
              </label>
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
              {accessMode !== 'presets' && (
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
            </div>
            <p className="mt-2 text-[11px] text-ink-faint">
              Write includes read for the same resource. Presets cover many scopes at once.
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
              disabled={createApiKey.isPending}
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

  const presets = scopes.filter(isApiKeyPresetScope)
  const granular = scopes.filter(isApiKeyGranularScope)

  if (granular.length === 0) {
    return presets.map((scope) => API_KEY_SCOPE_LABELS[scope]).join(', ')
  }

  if (presets.length === 0) {
    return `Custom (${String(scopes.length)} scopes)`
  }

  return [...presets.map((scope) => API_KEY_SCOPE_LABELS[scope]), `Custom (${String(granular.length)})`].join(
    ', ',
  )
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
    <div className="overflow-hidden rounded-md border border-border">
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
