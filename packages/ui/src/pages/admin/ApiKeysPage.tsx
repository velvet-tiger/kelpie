import { useSession } from '../../api/resources/session.ts'
import { ApiKeysPanel } from '../../components/ApiKeysPanel.tsx'
import { PageHeader } from '../../components/PageHeader.tsx'

/**
 * Workspace keys, for shared agents and CI.
 *
 * `GET /v1/api-keys?kind=workspace` needs the admin role; the server answers
 * `403` to anyone else. This page shows that plainly instead of rendering an
 * empty table, the same shape `WebhooksPage` uses for the same reason.
 */

export function ApiKeysPage(): React.JSX.Element {
  const { session } = useSession()
  const isAdmin = session?.role === 'owner' || session?.role === 'admin'

  return (
    <div className="animate-slide-in mx-auto max-w-4xl space-y-4">
      <PageHeader
        title="API keys"
        description="Workspace keys for shared agents and CI. Personal keys live under Account → API keys."
      />
      {isAdmin ? (
        <ApiKeysPanel
          kind="workspace"
          namePlaceholder="CI pipeline"
          createTitle="Create API key"
          emptyMessage="No API keys yet."
        />
      ) : (
        <MemberNotice />
      )}
    </div>
  )
}

function MemberNotice(): React.JSX.Element {
  return (
    <p className="rounded-md border border-border px-4 py-3 text-[13px] text-ink-muted">
      Workspace keys are managed by workspace admins.
    </p>
  )
}
