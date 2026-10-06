import type { McpTool } from '@kelpie/schemas'
import { useMemo, useState } from 'react'
import { Link } from 'react-router'

import { useMcpTools } from '../../api/resources/mcpTools.ts'
import { useSession } from '../../api/resources/session.ts'
import { ErrorPanel, LoadingPanel } from '../../components/QueryState.tsx'
import { CopyButton } from '../../components/CopyButton.tsx'
import { mcpClientConfig, mcpEndpoint } from '../../lib/mcpConfig.ts'

/**
 * How an agent connects to this workspace: the content of the AI page.
 *
 * Every member sees it. It is how to reach MCP, not a setting, and any member
 * can connect a client with a personal key or OAuth sign-in.
 *
 * Everything on the page is derived rather than written down. The endpoint comes
 * from the origin the browser reached the app on, the same way a form's embed URL
 * does, so it is right for a self-hosted install on any hostname. The tool list
 * comes from `/v1/mcp/tools`, which reads the registry the endpoint itself
 * dispatches against: a module that adds a resource shows up here without anyone
 * editing this file.
 *
 * Registered agents and their run log are configuration, and are on the Agents
 * tab of Admin → AI.
 */

/**
 * Matches a tool on its name or its description, so "csv" finds the import and
 * export tools and "pinned" finds the note list that filters on it.
 */
function matches(tool: McpTool, term: string): boolean {
  const needle = term.trim().toLowerCase()

  if (needle.length === 0) {
    return true
  }

  return (
    tool.name.toLowerCase().includes(needle) ||
    tool.description.toLowerCase().includes(needle)
  )
}

type ConnectMethod = 'sign-in' | 'api-key'

const CONNECT_METHODS: readonly { readonly id: ConnectMethod; readonly label: string }[] = [
  { id: 'sign-in', label: 'Sign in' },
  { id: 'api-key', label: 'API key' },
]

function methodClass(selected: boolean): string {
  return [
    'rounded-md border px-2.5 py-1 text-[12px] font-medium transition',
    selected
      ? 'border-accent bg-accent text-accent-fg'
      : 'border-border text-ink-muted hover:border-border-strong hover:text-ink',
  ].join(' ')
}

const STEP_HEADING = 'text-[13px] font-semibold text-ink'
const STEP_TEXT = 'mt-1 max-w-2xl text-[13px] leading-relaxed text-ink-muted'

/**
 * The AI page's content, as three steps in the order a member does them: copy
 * the address, connect, check. The tool list and the rules are closed below,
 * because a member reads them after the agent is connected, if at all.
 */
export function McpPanel(): React.JSX.Element {
  const endpoint = mcpEndpoint()
  // A member cannot open Admin, so only an admin gets the workspace keys link.
  const { session } = useSession()
  const isAdmin = session?.role === 'owner' || session?.role === 'admin'
  const config = mcpClientConfig(endpoint, 'kp_user_…')
  const [method, setMethod] = useState<ConnectMethod>('sign-in')

  return (
    <div className="space-y-4">
      <section className="rounded-md border border-border p-5">
        <div className="flex items-center justify-between gap-3">
          <h2 className={STEP_HEADING}>1. Copy the address</h2>
          <CopyButton value={endpoint} label="Copy the address" />
        </div>
        <code className="mt-3 block rounded-md border border-border bg-surface px-3 py-2.5 font-mono text-[13px] break-all text-ink">
          {endpoint}
        </code>
      </section>

      <section className="rounded-md border border-border p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className={STEP_HEADING}>2. Connect</h2>
          <div className="flex gap-1.5" role="group" aria-label="How to connect">
            {CONNECT_METHODS.map((option) => (
              <button
                key={option.id}
                type="button"
                aria-pressed={method === option.id}
                onClick={() => {
                  setMethod(option.id)
                }}
                className={methodClass(method === option.id)}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>

        {method === 'sign-in' ? (
          <>
            <p className={STEP_TEXT}>
              Use this if your client can sign in to an MCP server. A Claude.ai connector is one
              example.
            </p>
            <ol className="mt-3 list-decimal space-y-1.5 pl-5 text-[13px] text-ink">
              <li>Add a new MCP server in your client, and paste the address.</li>
              <li>A Kelpie page opens. Select one or more workspaces and approve the access.</li>
            </ol>
            <p className="mt-3 text-[12px] text-ink-muted">
              You can disconnect a client at any time under{' '}
              <Link to="/account/connected-apps" className="text-accent hover:underline">
                Connected apps
              </Link>
              .
            </p>
          </>
        ) : (
          <>
            <p className={STEP_TEXT}>
              Use this if your client reads a config file. Claude Code and Cursor are examples.
            </p>
            <ol className="mt-3 list-decimal space-y-1.5 pl-5 text-[13px] text-ink">
              <li>
                Create a personal key under{' '}
                <Link to="/account/api-keys" className="text-accent hover:underline">
                  API keys
                </Link>
                . Kelpie shows the key one time, so copy it then.
              </li>
              <li>
                Paste this config into your client, and put your key in the place of{' '}
                <code className="font-mono text-[12px]">kp_user_…</code>.
              </li>
            </ol>
            <div className="mt-3 flex justify-end">
              <CopyButton value={config} label="Copy the client config" />
            </div>
            <pre className="bg-code-bg text-code-fg mt-2 overflow-x-auto rounded-md border border-border p-4 font-mono text-[12px] leading-relaxed">
              {config}
            </pre>
            {isAdmin && (
              <p className="mt-3 text-[12px] text-ink-muted">
                For an agent that your team shares, use a workspace key from{' '}
                <Link to="/admin/api-keys" className="text-accent hover:underline">
                  Admin → API keys
                </Link>
                .
              </p>
            )}
          </>
        )}
      </section>

      <section className="rounded-md border border-border p-5">
        <h2 className={STEP_HEADING}>3. Check that it works</h2>
        <p className={STEP_TEXT}>
          Ask your agent: <span className="text-ink">“List the people in my CRM.”</span> If it
          shows your people, the connection works.
        </p>
      </section>

      <ToolCatalog />

      <details className="rounded-md border border-border px-5 py-3">
        <summary className="cursor-pointer text-[13px] font-semibold text-ink">Good to know</summary>
        <ul className="mt-3 max-w-2xl list-disc space-y-1.5 pb-2 pl-5 text-[13px] text-ink-muted">
          <li>
            A key is for one workspace. With sign-in, you select the workspaces, and your agent sees
            only those. If you select more than one, the agent must name the workspace on each
            action.
          </li>
          <li>
            Your agent reads and writes the same records that you see in the app. A tool follows
            the same rules as the app, and refuses what the app refuses.
          </li>
          <li>
            The address does not open in a browser. It answers only an MCP client that has a key or
            a sign-in.
          </li>
          <li>The connection type is MCP over Streamable HTTP, if your client asks for it.</li>
        </ul>
      </details>
    </div>
  )
}

/**
 * What this deployment actually registered, read from the endpoint's own registry.
 *
 * Closed until a member opens it: the list is long, and it is reference, not a
 * step. A flat list rather than a grouped one. Tool names are resource-then-verb, so
 * sorting by name already puts a resource's five together, and every rule for
 * grouping them turned out to be a lexical guess that read `webhooks_rotate_secret`
 * as a resource called `webhooks_rotate`.
 */
function ToolCatalog(): React.JSX.Element {
  const { records, isLoading, error } = useMcpTools()
  const [term, setTerm] = useState('')
  const shown = useMemo(
    () => [...records].filter((tool) => matches(tool, term)).sort((left, right) => left.name.localeCompare(right.name)),
    [records, term],
  )

  return (
    <details className="rounded-md border border-border px-5 py-3">
      <summary className="cursor-pointer text-[13px] font-semibold text-ink">
        What your agent can do
        {!isLoading && error === null && (
          <span className="ml-2 font-normal text-ink-muted">{String(records.length)} tools</span>
        )}
      </summary>
      <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-2xl text-[12px] text-ink-muted">
          {isLoading
            ? 'Reading what this deployment exposes.'
            : 'Each tool does one operation of the app, such as list people or create a note.'}
        </p>
        {records.length > 0 && (
          <input
            type="search"
            value={term}
            onChange={(event) => {
              setTerm(event.target.value)
            }}
            placeholder="Filter tools"
            aria-label="Filter tools"
            className="rounded-md border border-border bg-surface px-2.5 py-1 text-[12px] text-ink outline-none focus:border-border-strong"
          />
        )}
      </div>

      {error !== null && <div className="mt-4">{<ErrorPanel error={error} />}</div>}
      {isLoading && <LoadingPanel label="Loading tools…" />}

      {records.length > 0 && shown.length === 0 && (
        <p className="mt-4 text-[12px] text-ink-faint">No tool matches “{term}”.</p>
      )}

      {shown.length > 0 && (
        <ul className="mt-4 divide-y divide-border rounded-md border border-border">
          {shown.map((tool) => (
            <li key={tool.name} className="px-3 py-2.5">
              <code className="font-mono text-[12px] text-accent">{tool.name}</code>
              <p className="mt-0.5 text-[12px] leading-relaxed text-ink-muted">{tool.description}</p>
            </li>
          ))}
        </ul>
      )}
    </details>
  )
}
