import { ApiKeysPanel } from '../../components/ApiKeysPanel.tsx'
import { PageHeader } from '../../components/PageHeader.tsx'

/**
 * Personal keys: act as the signed-in member against the public API and MCP.
 *
 * No role gate. `GET /v1/api-keys?kind=personal` scopes itself to the caller —
 * every member manages their own, and an admin cannot see or revoke a
 * colleague's; removing their membership is how you cut that off.
 */

export function PersonalApiKeysPage(): React.JSX.Element {
  return (
    <div className="animate-slide-in space-y-4">
      <PageHeader
        title="API keys"
        description="Personal keys act as you against the public API and MCP. Workspace keys live under Admin."
      />
      <ApiKeysPanel
        kind="personal"
        namePlaceholder="Laptop Claude"
        createTitle="Create personal API key"
        emptyMessage="No personal API keys yet."
      />
    </div>
  )
}
