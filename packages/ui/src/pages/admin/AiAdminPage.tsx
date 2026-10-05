import type { ReactNode } from 'react'
import { Navigate, useSearchParams } from 'react-router'

import { PageHeader } from '../../components/PageHeader.tsx'
import { RecordTabs } from '../../components/RecordTabs.tsx'
import { useAdminTabs } from '../../registry/context.ts'
import { inSlotOrder } from '../../registry/registry.ts'
import { AgentsPanel } from './AgentsPanel.tsx'

/**
 * Admin → AI at `/admin/ai`: the AI configuration of this workspace.
 *
 * Core owns the page and its Agents tab, so every install has both. The optional
 * `ai` module adds Kelpie AI's Settings and Run log tabs through `adminTab`,
 * ordered before Agents. Without that module the page is Agents alone.
 *
 * The open tab is `?tab=`, so a link can open one. With no `tab`, or one no
 * module provides, the first tab opens. MCP was a tab here and is now the AI
 * page at `/ai`, which every member can open, so `?tab=mcp` redirects there.
 */

interface PageTab {
  readonly id: string
  readonly label: string
  readonly order?: number
  readonly render: () => ReactNode
}

const AGENTS_TAB: PageTab = { id: 'agents', label: 'Agents', order: 300, render: () => <AgentsPanel /> }

export function AiAdminPage(): React.JSX.Element {
  const moduleTabs = useAdminTabs('ai')
  const tabs = inSlotOrder<PageTab>([...moduleTabs, AGENTS_TAB])
  const [searchParams, setSearchParams] = useSearchParams()
  const requested = searchParams.get('tab')
  const active = tabs.find((tab) => tab.id === requested) ?? tabs[0] ?? AGENTS_TAB

  if (requested === 'mcp') {
    return <Navigate to="/ai" replace />
  }

  return (
    <div className="animate-slide-in mx-auto max-w-4xl space-y-6">
      <PageHeader title="AI" description="Register agents, and configure how agent tasks run." />
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
