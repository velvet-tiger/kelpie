import type { ReactNode } from 'react'
import { useSearchParams } from 'react-router'

import { PageHeader } from '../../components/PageHeader.tsx'
import { RecordTabs } from '../../components/RecordTabs.tsx'
import { useAdminTabs } from '../../registry/context.ts'
import { inSlotOrder } from '../../registry/registry.ts'
import { McpPanel } from './McpPanel.tsx'

/**
 * Admin → AI at `/admin/ai`: how agents reach this workspace.
 *
 * Core owns the page and its MCP tab, so every install has both. The optional
 * `ai` module adds Kelpie AI's Settings and Run log tabs through `adminTab`,
 * ordered before MCP. Without that module the page is MCP alone.
 *
 * The open tab is `?tab=`, so a link can open one; `/admin/mcp` redirects to
 * `?tab=mcp`. With no `tab`, or one no module provides, the first tab opens.
 */

interface PageTab {
  readonly id: string
  readonly label: string
  readonly order?: number
  readonly render: () => ReactNode
}

const MCP_TAB: PageTab = { id: 'mcp', label: 'MCP', order: 300, render: () => <McpPanel /> }

export function AiAdminPage(): React.JSX.Element {
  const moduleTabs = useAdminTabs('ai')
  const tabs = inSlotOrder<PageTab>([...moduleTabs, MCP_TAB])
  const [searchParams, setSearchParams] = useSearchParams()
  const requested = searchParams.get('tab')
  const active = tabs.find((tab) => tab.id === requested) ?? tabs[0] ?? MCP_TAB

  return (
    <div className="animate-slide-in mx-auto max-w-4xl space-y-6">
      <PageHeader title="AI" description="Connect agents to this workspace, and run agent tasks." />
      <RecordTabs
        tabs={tabs.map((tab) => ({ id: tab.id, label: tab.label }))}
        active={active.id}
        onChange={(id) => {
          setSearchParams({ tab: id }, { replace: true })
        }}
        ariaLabel="AI sections"
      >
        {active.render()}
      </RecordTabs>
    </div>
  )
}
