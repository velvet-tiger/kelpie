import { API_KEY_SCOPE_LABELS } from '@kelpie/schemas'
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
  const { isLoading: sessionLoading, isSignedOut, error: sessionError } = useSession()

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

  return <ConsentForRequest requestId={requestId} />
}

function ConsentForRequest({ requestId }: { readonly requestId: string }): React.JSX.Element {
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

  return <ConsentForm request={request} />
}

function ConsentForm({ request }: { readonly request: OAuthRequest }): React.JSX.Element {
  const approve = useApproveOAuthRequest()
  const deny = useDenyOAuthRequest()
  const [workspaceId, setWorkspaceId] = useState(request.workspaces[0]?.id ?? '')
  const [scopes, setScopes] = useState<readonly ApiKeyScope[]>(request.scopes)
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

  if (request.workspaces.length === 0) {
    return (
      <AuthLayout
        title={`Connect ${request.clientName}`}
        description="A connection is made to one workspace, and this account is not a member of any."
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

        <label className="block">
          <span className="mb-1.5 block text-[12px] font-medium text-ink">Workspace</span>
          <select
            value={workspaceId}
            onChange={(event) => {
              setWorkspaceId(event.target.value)
            }}
            className="w-full rounded-md border border-border bg-surface px-3 py-2 text-[13px] text-ink outline-none focus:border-accent"
          >
            {request.workspaces.map((workspace) => (
              <option key={workspace.id} value={workspace.id}>
                {workspace.name}
              </option>
            ))}
          </select>
          <span className="mt-1 block text-[11px] text-ink-faint">
            The app sees this workspace only. To use another, connect again.
          </span>
        </label>

        <fieldset>
          <legend className="mb-1.5 text-[12px] font-medium text-ink">Access</legend>
          <div className="space-y-1.5">
            {request.scopes.map((scope) => (
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
            The app can do no more than your own role allows. Clear an item to give less access.
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
            disabled={busy || scopes.length === 0 || workspaceId.length === 0}
            onClick={() => {
              approve
                .runAsync({ requestId: request.id, workspaceId, scopes })
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
