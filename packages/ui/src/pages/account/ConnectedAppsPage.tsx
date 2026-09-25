import { API_KEY_SCOPE_LABELS } from '@kelpie/schemas'
import type { OAuthGrant } from '@kelpie/schemas'
import { useState } from 'react'

import { useTimezone } from '../../api/resources/account.ts'
import { useOAuthGrants, useRevokeOAuthGrant } from '../../api/resources/oauth.ts'
import { PageHeader } from '../../components/PageHeader.tsx'
import { ErrorPanel, LoadingPanel } from '../../components/QueryState.tsx'
import { formatDate } from '../../lib/dates.ts'

/**
 * MCP clients this person connected through OAuth, across every workspace they
 * belong to. Private to them, as personal API keys are: an admin's control is
 * removing the member, which ends every connection in that workspace.
 */
export function ConnectedAppsPage(): React.JSX.Element {
  const { grants, isLoading, error } = useOAuthGrants()
  const revoke = useRevokeOAuthGrant()

  return (
    <div className="animate-slide-in space-y-4">
      <PageHeader
        title="Connected apps"
        description="Apps you connected through MCP sign-in. Each one acts as you, in one workspace."
      />

      {error !== null && <ErrorPanel error={error} />}
      {revoke.error !== null && <ErrorPanel error={revoke.error} />}

      {isLoading ? (
        <LoadingPanel label="Loading connected apps…" />
      ) : grants.length === 0 ? (
        <p className="rounded-md border border-border px-4 py-10 text-center text-[13px] text-ink-faint">
          No connected apps. When an MCP client asks you to sign in to Kelpie, it shows up here.
        </p>
      ) : (
        <div className="overflow-hidden rounded-md border border-border">
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
              {grants.map((grant) => (
                <GrantRow
                  key={grant.id}
                  grant={grant}
                  onRevoke={(id) => {
                    revoke.run(id)
                  }}
                  isRevoking={revoke.isPending}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

function GrantRow({
  grant,
  onRevoke,
  isRevoking,
}: {
  readonly grant: OAuthGrant
  readonly onRevoke: (id: string) => void
  readonly isRevoking: boolean
}): React.JSX.Element {
  const [isConfirming, setIsConfirming] = useState(false)
  const timezone = useTimezone()

  return (
    <tr className="border-b border-border last:border-0">
      <td className="px-4 py-3">
        <div className="font-medium">{grant.clientName}</div>
        <div className="font-mono text-[11px] text-ink-muted">{grant.clientHost}</div>
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
