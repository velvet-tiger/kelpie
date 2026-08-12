import {
  WEBHOOK_EVENTS,
  WEBHOOK_SECRET_OVERLAP_HOURS,
  WEBHOOK_STATUS_LABELS,
} from '@kelpie/schemas'
import type { CreatedWebhook, Webhook, WebhookEvent, WebhookStatus } from '@kelpie/schemas'
import { useState } from 'react'
import type { FormEvent } from 'react'

import { useTimezone } from '../../api/resources/account.ts'
import { useSession } from '../../api/resources/session.ts'
import {
  useCreateWebhook,
  useDeleteWebhook,
  useRotateWebhookSecret,
  useUpdateWebhook,
  useWebhooks,
} from '../../api/resources/webhooks.ts'
import { Chip } from '../../components/Chip.tsx'
import type { ChipTone } from '../../components/Chip.tsx'
import { PageHeader } from '../../components/PageHeader.tsx'
import { ErrorPanel, LoadingPanel } from '../../components/QueryState.tsx'
import { formatDateTime } from '../../lib/dates.ts'
import { WebhookDeliveries } from './WebhookDeliveries.tsx'

/**
 * Where a workspace points its event deliveries.
 *
 * The mockup's version was local state, so its secret was decorative and its
 * `paused` chip had nothing that could produce one. Both are real here: the
 * secret is minted server-side and shown once, and pausing is a control.
 *
 * `failing` is deliberately not a control. It is what the delivery engine
 * reports about the endpoint, and the API refuses a request that claims it.
 */

const STATUS_TONES: Readonly<Record<WebhookStatus, ChipTone>> = {
  active: 'success',
  failing: 'danger',
  paused: 'warning',
}

export function WebhooksPage(): React.JSX.Element {
  const { session } = useSession()
  const isAdmin = session?.role === 'owner' || session?.role === 'admin'

  return (
    <div className="animate-slide-in mx-auto max-w-4xl space-y-6">
      <PageHeader title="Webhooks" description="Push record events to your own endpoints." />
      {isAdmin ? <WebhookAdmin /> : <MemberNotice />}
    </div>
  )
}

/**
 * Shown instead of the page rather than beside an empty table.
 *
 * A member's `GET` answers `403`, so there is nothing to render, and an empty
 * list would read as "no webhooks" when the truth is "not yours to see".
 */
function MemberNotice(): React.JSX.Element {
  return (
    <p className="rounded-md border border-border px-4 py-3 text-[13px] text-ink-muted">
      Webhooks are managed by workspace admins. An endpoint URL often carries its own credential, so
      the registrations are not listed to other members.
    </p>
  )
}

function WebhookAdmin(): React.JSX.Element {
  const { records, isLoading, error, hasMore, isLoadingMore, loadMore } = useWebhooks()
  const [minted, setMinted] = useState<CreatedWebhook | null>(null)

  return (
    <>
      <RegisterForm
        onRegistered={(webhook) => {
          setMinted(webhook)
        }}
      />

      {minted !== null && (
        <SecretOnce
          webhook={minted}
          onDismiss={() => {
            setMinted(null)
          }}
        />
      )}

      {error !== null && <ErrorPanel error={error} />}

      {isLoading ? (
        <LoadingPanel label="Loading webhooks…" />
      ) : records.length === 0 ? (
        <p className="text-[13px] text-ink-muted">No webhooks yet.</p>
      ) : (
        <ul className="space-y-3">
          {records.map((webhook) => (
            <WebhookRow key={webhook.id} webhook={webhook} onRotated={setMinted} />
          ))}
        </ul>
      )}

      {hasMore && (
        <button
          type="button"
          disabled={isLoadingMore}
          onClick={loadMore}
          className="rounded-md border border-border px-3 py-1.5 text-[12px] font-medium text-ink-muted transition hover:text-ink disabled:opacity-50"
        >
          {isLoadingMore ? 'Loading…' : 'Load more'}
        </button>
      )}
    </>
  )
}

function RegisterForm({
  onRegistered,
}: {
  readonly onRegistered: (webhook: CreatedWebhook) => void
}): React.JSX.Element {
  const createWebhook = useCreateWebhook()
  const [url, setUrl] = useState('')
  const [events, setEvents] = useState<readonly WebhookEvent[]>(['record.created'])

  function toggle(event: WebhookEvent): void {
    setEvents((current) =>
      current.includes(event)
        ? current.filter((name) => name !== event)
        : // Kept in catalogue order rather than click order, so two identical
          // selections read the same in the list.
          WEBHOOK_EVENTS.filter((name) => name === event || current.includes(name)),
    )
  }

  function submit(formEvent: FormEvent): void {
    formEvent.preventDefault()

    createWebhook
      .runAsync({ url: url.trim(), events })
      .then((webhook) => {
        setUrl('')
        setEvents(['record.created'])
        onRegistered(webhook)
      })
      .catch(() => undefined)
  }

  return (
    <form onSubmit={submit} className="space-y-3 rounded-md border border-border p-4">
      <label className="block">
        <span className="mb-1.5 block text-[12px] font-medium text-ink">Endpoint URL</span>
        <input
          value={url}
          onChange={(event) => {
            setUrl(event.target.value)
          }}
          required
          placeholder="https://example.com/webhooks/kelpie"
          className="w-full rounded-md border border-border bg-surface px-3 py-2 font-mono text-[13px] outline-none focus:border-accent focus:ring-2 focus:ring-accent/20"
        />
      </label>

      <div>
        <span className="mb-1.5 block text-[12px] font-medium text-ink">Events</span>
        <div className="flex flex-wrap gap-2">
          {WEBHOOK_EVENTS.map((event) => (
            <label
              key={event}
              className={[
                'cursor-pointer rounded-md border px-2.5 py-1 font-mono text-[11px] transition',
                events.includes(event)
                  ? 'border-accent bg-accent-soft text-accent-hover'
                  : 'border-border text-ink-muted hover:border-border-strong',
              ].join(' ')}
            >
              <input
                type="checkbox"
                className="sr-only"
                checked={events.includes(event)}
                onChange={() => {
                  toggle(event)
                }}
              />
              {event}
            </label>
          ))}
        </div>
      </div>

      {createWebhook.error !== null && <ErrorPanel error={createWebhook.error} />}

      <button
        type="submit"
        // The API refuses an empty list too; disabling here says so before the
        // round trip rather than instead of it.
        disabled={createWebhook.isPending || events.length === 0}
        className="rounded-md bg-accent px-3.5 py-2 text-[12px] font-semibold text-accent-fg transition hover:bg-accent-hover disabled:opacity-50"
      >
        {createWebhook.isPending ? 'Adding…' : 'Add webhook'}
      </button>
    </form>
  )
}

/**
 * The signing secret, shown once.
 *
 * Nothing can retrieve it afterwards, so this panel says so plainly instead of
 * leaving a reader to discover it by coming back for the value later.
 */
function SecretOnce({
  webhook,
  onDismiss,
}: {
  readonly webhook: CreatedWebhook
  readonly onDismiss: () => void
}): React.JSX.Element {
  return (
    <div className="rounded-md border border-accent/40 bg-accent-soft px-4 py-3">
      <p className="text-[13px] font-medium text-ink">
        Copy this signing secret now. It is not shown again.
      </p>
      <p className="mt-1 text-[12px] text-ink-muted">
        Each delivery carries <span className="font-mono">Kelpie-Signature: sha256=…</span>, an
        HMAC-SHA256 of the exact request body under this secret.
      </p>
      <code className="mt-2 block break-all rounded border border-border bg-surface px-3 py-2 font-mono text-[12px] text-ink">
        {webhook.secret}
      </code>
      <button
        type="button"
        onClick={onDismiss}
        className="mt-2 text-[12px] font-medium text-accent hover:underline"
      >
        I have copied it
      </button>
    </div>
  )
}

function WebhookRow({
  webhook,
  onRotated,
}: {
  readonly webhook: Webhook
  readonly onRotated: (webhook: CreatedWebhook) => void
}): React.JSX.Element {
  const updateWebhook = useUpdateWebhook()
  const deleteWebhook = useDeleteWebhook()
  const rotateSecret = useRotateWebhookSecret()
  const timezone = useTimezone()
  const [isConfirmingRemoval, setIsConfirmingRemoval] = useState(false)
  const [isShowingDeliveries, setIsShowingDeliveries] = useState(false)
  const [isRotating, setIsRotating] = useState(false)
  const failure = updateWebhook.error ?? deleteWebhook.error ?? rotateSecret.error

  return (
    <li className="rounded-md border border-border p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <code className="font-mono text-[13px] break-all text-ink">{webhook.url}</code>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {webhook.events.map((event) => (
              <Chip key={event}>{event}</Chip>
            ))}
          </div>
        </div>
        <div className="flex items-center gap-3">
          <Chip tone={STATUS_TONES[webhook.status]}>{WEBHOOK_STATUS_LABELS[webhook.status]}</Chip>
          <button
            type="button"
            disabled={updateWebhook.isPending}
            onClick={() => {
              updateWebhook.run({
                id: webhook.id,
                changes: { status: webhook.status === 'paused' ? 'active' : 'paused' },
              })
            }}
            className="text-[12px] font-medium text-ink-muted hover:text-ink disabled:opacity-50"
          >
            {webhook.status === 'paused' ? 'Resume' : 'Pause'}
          </button>
          {isConfirmingRemoval ? (
            <>
              <button
                type="button"
                onClick={() => {
                  setIsConfirmingRemoval(false)
                }}
                className="text-[12px] font-medium text-ink-muted hover:text-ink"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={deleteWebhook.isPending}
                onClick={() => {
                  deleteWebhook.run(webhook.id)
                }}
                className="rounded-md bg-danger px-2.5 py-1 text-[12px] font-semibold text-danger-fg transition hover:opacity-90 disabled:opacity-50"
              >
                {deleteWebhook.isPending ? 'Removing…' : 'Remove'}
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={() => {
                setIsConfirmingRemoval(true)
              }}
              className="text-[12px] font-medium text-danger hover:underline"
            >
              Remove
            </button>
          )}
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-4 text-[11px] text-ink-faint">
        <span className="font-mono">Secret {webhook.secretPrefix}</span>
        <span>Last delivery: {describeLastDelivery(webhook, timezone)}</span>
        <button
          type="button"
          aria-expanded={isShowingDeliveries}
          onClick={() => {
            setIsShowingDeliveries((current) => !current)
          }}
          className="font-medium text-accent hover:underline"
        >
          {isShowingDeliveries ? 'Hide deliveries' : 'Deliveries'}
        </button>
        <button
          type="button"
          aria-expanded={isRotating}
          onClick={() => {
            setIsRotating((current) => !current)
          }}
          className="font-medium text-accent hover:underline"
        >
          {isRotating ? 'Cancel rotation' : 'Rotate secret'}
        </button>
      </div>

      {isRotating && (
        <RotatePanel
          isPending={rotateSecret.isPending}
          onRotate={(overlap) => {
            rotateSecret
              .runAsync({ id: webhook.id, overlap })
              .then((rotated) => {
                setIsRotating(false)
                onRotated(rotated)
              })
              .catch(() => undefined)
          }}
        />
      )}

      {/* Mounted rather than hidden, so an unopened row costs no request. */}
      {isShowingDeliveries && (
        <div className="mt-4 border-t border-border pt-4">
          <WebhookDeliveries webhookId={webhook.id} />
        </div>
      )}

      {failure !== null && (
        <div className="mt-3">
          <ErrorPanel error={failure} />
        </div>
      )}
    </li>
  )
}

/**
 * The one choice a rotation offers, and it is worth a panel rather than a
 * confirm dialog.
 *
 * Rotating with no overlap replaces the secret the instant it is pressed, so
 * every delivery fails until the new one is live on the customer's server. The
 * checkbox is off by default because it is the tighter security answer: it is
 * the right choice for a secret that has actually leaked, where honouring the
 * old one for another day is the thing you are trying to stop.
 */
function RotatePanel({
  isPending,
  onRotate,
}: {
  readonly isPending: boolean
  readonly onRotate: (overlap: boolean) => void
}): React.JSX.Element {
  const [overlap, setOverlap] = useState(false)

  return (
    <div className="mt-3 rounded-md border border-border bg-surface-sunken p-3">
      <p className="text-[12px] font-medium text-ink">Replace the signing secret</p>
      <p className="mt-1 text-[11px] text-ink-muted">
        The webhook keeps its id, its events and its delivery log. The new secret is shown once.
      </p>

      <label className="mt-3 flex cursor-pointer items-start gap-2">
        <input
          type="checkbox"
          checked={overlap}
          onChange={(event) => {
            setOverlap(event.target.checked)
          }}
          className="mt-0.5"
        />
        <span className="text-[11px] text-ink-muted">
          <span className="font-medium text-ink">
            Keep accepting the old secret for {WEBHOOK_SECRET_OVERLAP_HOURS} hours
          </span>
          <br />
          Each delivery is signed with both, so nothing fails while you roll the new secret out.
          Leave this off if the old secret has leaked: it stops working immediately, and deliveries
          fail until you have deployed the new one.
        </span>
      </label>

      <button
        type="button"
        disabled={isPending}
        onClick={() => {
          onRotate(overlap)
        }}
        className="mt-3 rounded-md bg-accent px-3 py-1.5 text-[12px] font-semibold text-accent-fg transition hover:bg-accent-hover disabled:opacity-50"
      >
        {isPending ? 'Rotating…' : 'Rotate secret'}
      </button>
    </div>
  )
}

/** Both fields are null together until the first delivery settles. */
function describeLastDelivery(webhook: Webhook, timezone: string): string {
  if (webhook.lastDeliveryAt === null || webhook.lastDeliveryStatus === null) {
    return 'Never'
  }

  return `${formatDateTime(webhook.lastDeliveryAt, timezone)} (${webhook.lastDeliveryStatus})`
}
