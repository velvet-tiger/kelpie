import { API_KEY_SCOPE_LABELS } from '@kelpie/schemas'
import type { OAuthGrant } from '@kelpie/schemas'
import { useState } from 'react'

import { useTimezone } from '../../api/resources/account.ts'
import { useOAuthGrants, useRevokeOAuthConnection, useRevokeOAuthGrant } from '../../api/resources/oauth.ts'
import { PageHeader } from '../../components/PageHeader.tsx'
import { ErrorPanel, LoadingPanel } from '../../components/QueryState.tsx'
import { formatDate } from '../../lib/dates.ts'

/**
 * MCP clients this person connected through OAuth, across every workspace they
 * belong to. Private to them, as personal API keys are: an admin's control is
 * removing the member, which ends every connection in that workspace.
 *
 * One row for each workspace of a connection, so a person can disconnect one
 * workspace and keep the others. Workspaces that were approved together are
 * listed together, and the first of them carries the action that ends them all.
 */

/** A connection's rows next to each other, in the order the connections arrived. */
function byConnection(grants: readonly OAuthGrant[]): readonly (readonly OAuthGrant[])[] {
  const groups = new Map<string, OAuthGrant[]>()

  for (const grant of grants) {
    groups.set(grant.connectionId, [...(groups.get(grant.connectionId) ?? []), grant])
  }

  return [...groups.values()]
}

export function ConnectedAppsPage(): React.JSX.Element {
  const { grants, isLoading, error } = useOAuthGrants()
  const revoke = useRevokeOAuthGrant()
  const revokeConnection = useRevokeOAuthConnection()

  return (
    <div className="animate-slide-in space-y-4">
      <PageHeader
        title="Connected apps"
        description="Apps you connected through MCP sign-in. Each one acts as you, in the workspaces you approved."
      />

      {error !== null && <ErrorPanel error={error} />}
      {revoke.error !== null && <ErrorPanel error={revoke.error} />}
      {revokeConnection.error !== null && <ErrorPanel error={revokeConnection.error} />}

      {isLoading ? (
        <LoadingPanel label="Loading connected apps…" />
      ) : grants.length === 0 ? (
        <p className="rounded-md border border-border px-4 py-10 text-center text-[13px] text-ink-faint">
          No connected apps. When an MCP client asks you to sign in to Kelpie, it shows up here.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-md border border-border">
          <table className="w-full text-left text-[13px]">
            <thead>
              <tr className="border-b border-border bg-surface text-[11px] font-semibold tracking-wide text-ink-muted uppercase">
                <th className="px-4 py-2.5">App</th>
                <th className="px-4 py-2.5">Workspace</th>
                <th className="px-4 py-2.5">Access</th>
                <th className="px-4 py-2.5">Connected</th>
                <th className="px-4 py-2.5">Last used</th>
                <th className="px-4 py-2.5 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {byConnection(grants).flatMap((group) =>
                group.map((grant, index) => (
                  <GrantRow
                    key={grant.id}
                    grant={grant}
                    // Only a connection with more than one workspace needs the
                    // second action: with one, Disconnect already ends it.
                    connectionSize={index === 0 ? group.length : 0}
                    onRevoke={(id) => {
                      revoke.run(id)
                    }}
                    onRevokeConnection={(id) => {
                      revokeConnection.run(id)
                    }}
                    isRevoking={revoke.isPending || revokeConnection.isPending}
                  />
                )),
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

function GrantRow({
  grant,
  connectionSize,
  onRevoke,
  onRevokeConnection,
  isRevoking,
}: {
  readonly grant: OAuthGrant
  /** How many workspaces the connection covers, on its first row. Zero on the others. */
  readonly connectionSize: number
  readonly onRevoke: (id: string) => void
  readonly onRevokeConnection: (connectionId: string) => void
  readonly isRevoking: boolean
}): React.JSX.Element {
  const [isConfirming, setIsConfirming] = useState(false)
  const [isConfirmingAll, setIsConfirmingAll] = useState(false)
  const timezone = useTimezone()

  return (
    <tr className="border-b border-border last:border-0">
      <td className="px-4 py-3">
        <div className="font-medium">{grant.clientName}</div>
        <div className="font-mono text-[11px] text-ink-muted">{grant.clientHost}</div>
        {connectionSize > 1 &&
          (isConfirmingAll ? (
            <span className="mt-1 inline-flex items-center gap-3">
              <button
                type="button"
                onClick={() => {
                  setIsConfirmingAll(false)
                }}
                className="text-[12px] font-medium text-ink-muted hover:text-ink"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={isRevoking}
                onClick={() => {
                  onRevokeConnection(grant.connectionId)
                }}
                className="text-[12px] font-medium text-danger hover:underline disabled:opacity-50"
              >
                Disconnect all {connectionSize} workspaces
              </button>
            </span>
          ) : (
            <button
              type="button"
              onClick={() => {
                setIsConfirmingAll(true)
              }}
              className="mt-1 block text-[12px] font-medium text-danger hover:underline"
            >
              Disconnect all
            </button>
          ))}
      </td>
      <td className="px-4 py-3 text-ink-muted">{grant.workspaceName}</td>
      <td className="px-4 py-3 text-ink-muted">
        {grant.scopes.map((scope) => API_KEY_SCOPE_LABELS[scope]).join(', ')}
      </td>
      <td className="px-4 py-3 text-ink-muted">{formatDate(grant.createdAt, timezone)}</td>
      <td className="px-4 py-3 text-ink-muted">
        {grant.lastUsedAt === null ? 'Never' : formatDate(grant.lastUsedAt, timezone)}
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
                onRevoke(grant.id)
              }}
              className="text-[12px] font-medium text-danger hover:underline disabled:opacity-50"
            >
              {isRevoking ? 'Disconnecting…' : 'Disconnect'}
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
            Disconnect
          </button>
        )}
      </td>
    </tr>
  )
}
