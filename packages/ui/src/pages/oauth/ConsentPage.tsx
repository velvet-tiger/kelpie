import { API_KEY_SCOPE_LABELS, expandApiKeyScopes, isApiKeyPresetScope } from '@kelpie/schemas'
import type { ApiKeyScope, OAuthRequest } from '@kelpie/schemas'
import { useState } from 'react'
import { Link, Navigate, useParams } from 'react-router'

import { useApproveOAuthRequest, useDenyOAuthRequest, useOAuthRequest } from '../../api/resources/oauth.ts'
import { useSession } from '../../api/resources/session.ts'
import { ErrorPanel, LoadingPanel } from '../../components/QueryState.tsx'
import { AuthLayout } from '../auth/AuthLayout.tsx'

/**
 * Where an MCP client sends a person to approve a connection:
 * `/consent/:requestId`, reached by redirect from `/oauth/authorize`.
 *
 * Outside the session gate, like `/join`: a signed-out person is sent to sign
 * in and brought back here, rather than landing on the dashboard with the
 * request lost.
 *
 * The page shows the client's host as well as its name. A name is whatever the
 * client registered; the host is where the browser will be sent, and is the
 * part a person can check.
 */
export function ConsentPage(): React.JSX.Element {
  const { requestId = '' } = useParams()
  const { session, isLoading: sessionLoading, isSignedOut, error: sessionError } = useSession()

  if (isSignedOut) {
    return <Navigate to={`/login?next=${encodeURIComponent(`/consent/${requestId}`)}`} replace />
  }

  if (sessionError !== null) {
    return (
      <AuthLayout title="Connect an app">
        <div className="mt-4">
          <ErrorPanel error={sessionError} />
        </div>
      </AuthLayout>
    )
  }

  if (sessionLoading) {
    return <LoadingPanel />
  }

  return <ConsentForRequest requestId={requestId} activeWorkspaceId={session?.workspaceId ?? null} />
}

interface ConsentForRequestProps {
  readonly requestId: string
  /** The workspace the session is in, which is the one ticked at the start. */
  readonly activeWorkspaceId: string | null
}

function ConsentForRequest({ requestId, activeWorkspaceId }: ConsentForRequestProps): React.JSX.Element {
  const { request, isLoading, error } = useOAuthRequest(requestId)

  if (error !== null) {
    return (
      <AuthLayout
        title="This request is no longer valid"
        description="It has expired, or it was already answered. Go back to the app and connect again."
      >
        <div className="mt-4">
          <ErrorPanel error={error} />
        </div>
      </AuthLayout>
    )
  }

  if (isLoading || request === undefined) {
    return <LoadingPanel label="Loading the request…" />
  }

  return <ConsentForm request={request} activeWorkspaceId={activeWorkspaceId} />
}

interface ConsentFormProps {
  readonly request: OAuthRequest
  readonly activeWorkspaceId: string | null
}

/**
 * The workspace ticked when the page opens: the one the session is in, or the
 * first when the session has none the person can connect. One, never all: a
 * person who only clicks Allow gives the app the workspace they are working in.
 */
function initialWorkspaceIds(request: OAuthRequest, activeWorkspaceId: string | null): readonly string[] {
  const active = request.workspaces.find((workspace) => workspace.id === activeWorkspaceId)
  const first = active ?? request.workspaces[0]

  return first === undefined ? [] : [first.id]
}

/**
 * The scopes the page offers: each preset the app asked for, then each
 * per-resource scope that none of those presets includes.
 *
 * A per-resource scope inside a requested preset is not listed. The preset
 * grants it, so a separate tick box for it would change nothing. Only the
 * listed scopes are approved: clearing a preset also drops what it included.
 */
function offeredScopes(requested: readonly ApiKeyScope[]): readonly ApiKeyScope[] {
  const presets = requested.filter(isApiKeyPresetScope)
  const included: ReadonlySet<ApiKeyScope> = expandApiKeyScopes(presets)

  return [...presets, ...requested.filter((scope) => !isApiKeyPresetScope(scope) && !included.has(scope))]
}

function ConsentForm({ request, activeWorkspaceId }: ConsentFormProps): React.JSX.Element {
  const approve = useApproveOAuthRequest()
  const deny = useDenyOAuthRequest()
  const [workspaceIds, setWorkspaceIds] = useState<readonly string[]>(() =>
    initialWorkspaceIds(request, activeWorkspaceId),
  )
  const [onlyWorkspace] = request.workspaces
  const offered = offeredScopes(request.scopes)
  const [scopes, setScopes] = useState<readonly ApiKeyScope[]>(offered)
  const [leaving, setLeaving] = useState(false)
  const busy = approve.isPending || deny.isPending || leaving

  function leaveTo(url: string): void {
    // The redirect goes to the client, which may be another site or an app on
    // this computer, so it is a full navigation and not a router one.
    setLeaving(true)
    window.location.assign(url)
  }

  function toggle(scope: ApiKeyScope): void {
    setScopes((current) => (current.includes(scope) ? current.filter((entry) => entry !== scope) : [...current, scope]))
  }

  function toggleWorkspace(id: string): void {
    setWorkspaceIds((current) => (current.includes(id) ? current.filter((entry) => entry !== id) : [...current, id]))
  }

  if (request.workspaces.length === 0) {
    return (
      <AuthLayout
        title={`Connect ${request.clientName}`}
        description="A connection is made to a workspace, and this account is not a member of any."
      >
        <p className="mt-4 text-[13px] text-ink-muted">
          <Link to="/onboarding/workspace" className="text-accent hover:underline">
            Create a workspace
          </Link>
          , then go back to the app and connect again.
        </p>
      </AuthLayout>
    )
  }

  if (leaving) {
    return (
      <AuthLayout title="Returning to the app" description={`Sending you back to ${request.clientHost}.`}>
        <p className="mt-4 text-[13px] text-ink-muted">You can close this tab if it does not move on.</p>
      </AuthLayout>
    )
  }

  return (
    <AuthLayout
      title={`Connect ${request.clientName}`}
      description="This app wants to use Kelpie as you, through MCP."
      footer={
        <p className="text-[11px] text-ink-faint">
          Remove the connection at any time under Account, Connected apps.
        </p>
      }
    >
      <div className="mt-5 space-y-4">
        <div className="rounded-md border border-border bg-surface px-3 py-2.5">
          <p className="text-[11px] font-medium tracking-wide text-ink-muted uppercase">Sends you back to</p>
          <p className="mt-0.5 font-mono text-[13px] break-all text-ink">{request.clientHost}</p>
          {request.clientUri !== null && (
            <a
              href={request.clientUri}
              target="_blank"
              rel="noreferrer"
              className="mt-1 inline-block text-[12px] text-accent hover:underline"
            >
              About this app
            </a>
          )}
        </div>

        {request.workspaces.length === 1 && onlyWorkspace !== undefined ? (
          <div>
            <p className="mb-1.5 text-[12px] font-medium text-ink">Workspace</p>
            <p className="text-[13px] text-ink">
              {onlyWorkspace.name}{' '}
              <span className="text-ink-muted capitalize">({onlyWorkspace.role})</span>
            </p>
            <p className="mt-1 text-[11px] text-ink-faint">The app sees this workspace only.</p>
          </div>
        ) : (
          <fieldset>
            <legend className="mb-1.5 text-[12px] font-medium text-ink">Workspaces</legend>
            <div className="space-y-1.5">
              {request.workspaces.map((workspace) => (
                <label key={workspace.id} className="flex items-center gap-2 text-[13px] text-ink">
                  <input
                    type="checkbox"
                    checked={workspaceIds.includes(workspace.id)}
                    onChange={() => {
                      toggleWorkspace(workspace.id)
                    }}
                  />
                  <span className="min-w-0 flex-1 truncate">{workspace.name}</span>
                  <span className="shrink-0 text-[11px] text-ink-muted capitalize">{workspace.role}</span>
                </label>
              ))}
            </div>
            <p className="mt-1.5 text-[11px] text-ink-faint">
              {workspaceIds.length > 1
                ? 'The app can read and write in each of these workspaces.'
                : 'The app sees only the workspaces you select.'}
            </p>
          </fieldset>
        )}

        <fieldset>
          <legend className="mb-1.5 text-[12px] font-medium text-ink">Access</legend>
          <div className="space-y-1.5">
            {offered.map((scope) => (
              <label key={scope} className="flex items-center gap-2 text-[13px] text-ink">
                <input
                  type="checkbox"
                  checked={scopes.includes(scope)}
                  onChange={() => {
                    toggle(scope)
                  }}
                />
                {API_KEY_SCOPE_LABELS[scope]}
              </label>
            ))}
          </div>
          <p className="mt-1.5 text-[11px] text-ink-faint">
            The app can do no more than your own role allows. Clear an item to give less access. A wider item,
            such as Read all, includes the narrower ones.
          </p>
        </fieldset>

        {approve.error !== null && <ErrorPanel error={approve.error} />}
        {deny.error !== null && <ErrorPanel error={deny.error} />}

        <div className="flex gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              deny
                .runAsync(request.id)
                .then((decision) => {
                  leaveTo(decision.redirectUrl)
                })
                .catch(() => undefined)
            }}
            className="flex-1 rounded-md border border-border px-3.5 py-2 text-[12px] font-semibold text-ink transition hover:border-border-strong disabled:opacity-50"
          >
            Deny
          </button>
          <button
            type="button"
            disabled={busy || scopes.length === 0 || workspaceIds.length === 0}
            onClick={() => {
              approve
                .runAsync({ requestId: request.id, workspaceIds, scopes })
                .then((decision) => {
                  leaveTo(decision.redirectUrl)
                })
                .catch(() => undefined)
            }}
            className="flex-1 rounded-md bg-accent px-3.5 py-2 text-[12px] font-semibold text-accent-fg transition hover:bg-accent-hover disabled:opacity-50"
          >
            {approve.isPending ? 'Connecting…' : 'Allow'}
          </button>
        </div>
      </div>
    </AuthLayout>
  )
}
