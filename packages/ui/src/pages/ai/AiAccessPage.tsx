import { PageHeader } from '../../components/PageHeader.tsx'
import { McpPanel } from './McpPanel.tsx'

/**
 * AI at `/ai`: how a member's agent reaches this workspace.
 *
 * Outside Admin, so every member can open it. Any member can use MCP with a
 * personal key or OAuth sign-in, and this page is where they find the address.
 * Settings for AI stay under Admin → AI.
 *
 * No tab strip while MCP is the only content. Add one with the second tab.
 */
export function AiAccessPage(): React.JSX.Element {
  return (
    <div className="animate-slide-in mx-auto max-w-4xl">
      <PageHeader
        title="Connect your agent"
        description="Give Claude, Cursor, or another MCP client access to this workspace."
      />
      <McpPanel />
    </div>
  )
}
