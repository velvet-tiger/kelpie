import type { ApiKey, ApiKeyKind, CreatedApiKey } from '@kelpie/schemas'
import { useState } from 'react'
import type { FormEvent } from 'react'

import { useApiKeys, useCreateApiKey, useRevokeApiKey } from '../api/resources/apiKeys.ts'
import { formatDate } from '../lib/dates.ts'
import { CopyButton } from './CopyButton.tsx'
import { ErrorPanel, LoadingPanel } from './QueryState.tsx'

/**
 * The create/list/revoke flow shared by workspace keys (`/admin/api-keys`) and
 * personal keys (`/account/api-keys`).
 *
 * `kind` and the three strings below are the only difference between the two
 * pages, the same way `KanbanBoard` takes a `kind` for Deals versus
 * Opportunities. Who may reach this component at all — the admin gate on the
 * workspace page, none on the personal page — is the caller's decision; the API
 * enforces its own half regardless.
 */

export interface ApiKeysPanelProps {
  readonly kind: ApiKeyKind
  /** Shown in the create form's name field, e.g. "CI pipeline" or "Laptop Claude". */
  readonly namePlaceholder: string
  readonly createTitle: string
  readonly emptyMessage: string
}

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

  function submit(event: FormEvent): void {
    event.preventDefault()
    createApiKey
      .runAsync({ name: name.trim(), kind })
      .then(onCreated)
      .catch(() => undefined)
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 p-4">
      <div className="animate-slide-in w-full max-w-md rounded-md border border-border bg-surface-raised p-5">
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

/**
 * The secret, shown once.
 *
 * Nothing can retrieve it afterwards, so this panel says so plainly instead of
 * leaving a reader to discover it by coming back for the value later.
 */
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

/**
 * Revoking a key takes effect at once and cannot be undone, so this asks first,
 * the same two-step confirm `WebhooksPage` uses for removing a registration.
 */
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

  return (
    <tr className="border-b border-border last:border-0">
      <td className="px-4 py-3 font-medium">{apiKey.name}</td>
      <td className="px-4 py-3 font-mono text-[12px] text-ink-muted">{apiKey.displayPrefix}</td>
      <td className="px-4 py-3 text-ink-muted">{formatDate(apiKey.createdAt)}</td>
      <td className="px-4 py-3 text-ink-muted">
        {apiKey.lastUsedAt === null ? 'Never' : formatDate(apiKey.lastUsedAt)}
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
