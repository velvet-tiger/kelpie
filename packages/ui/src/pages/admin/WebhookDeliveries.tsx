import { WEBHOOK_DELIVERY_RETENTION_DAYS } from '@kelpie/schemas'
import type { WebhookDelivery, WebhookDeliveryStatus } from '@kelpie/schemas'
import { useState } from 'react'

import { useWebhookDeliveries } from '../../api/resources/webhooks.ts'
import { Chip } from '../../components/Chip.tsx'
import type { ChipTone } from '../../components/Chip.tsx'
import { DataTable } from '../../components/DataTable.tsx'
import type { Column } from '../../components/DataTable.tsx'
import { ErrorPanel, LoadingPanel } from '../../components/QueryState.tsx'
import { SegmentedControl } from '../../components/SegmentedControl.tsx'
import { formatDateTime } from '../../lib/dates.ts'

/**
 * What this webhook has actually sent.
 *
 * The row above shows only the newest delivery, which is the whole story for a
 * healthy endpoint and useless for a failing one: it cannot say which event
 * failed, how many attempts it took, or whether anything succeeded before it.
 *
 * Mounted only while a row is expanded, so a page listing ten registrations
 * makes no delivery request until somebody asks for one.
 */

type StatusFilter = 'all' | WebhookDeliveryStatus

const STATUS_OPTIONS = [
  { id: 'all' as const, label: 'All' },
  { id: 'success' as const, label: 'Success' },
  { id: 'failed' as const, label: 'Failed' },
]

const STATUS_TONES: Readonly<Record<WebhookDeliveryStatus, ChipTone>> = {
  success: 'success',
  failed: 'danger',
}

export function WebhookDeliveries({ webhookId }: { readonly webhookId: string }): React.JSX.Element {
  const [status, setStatus] = useState<StatusFilter>('all')
  const [openPayloadId, setOpenPayloadId] = useState<string | null>(null)
  const deliveries = useWebhookDeliveries(webhookId, {
    status: status === 'all' ? undefined : status,
  })
  const open = deliveries.records.find((delivery) => delivery.id === openPayloadId)

  const columns: readonly Column<WebhookDelivery>[] = [
    {
      key: 'event',
      header: 'Event',
      render: (delivery) => <span className="font-mono text-[12px] text-ink">{delivery.event}</span>,
    },
    {
      key: 'status',
      header: 'Status',
      className: 'w-24',
      render: (delivery) => <Chip tone={STATUS_TONES[delivery.status]}>{delivery.status}</Chip>,
    },
    {
      key: 'attempts',
      header: 'Attempts',
      className: 'w-20',
      render: (delivery) => (
        <span className="text-[12px] text-ink-muted">{delivery.attempts}</span>
      ),
    },
    {
      key: 'sent',
      header: 'Sent',
      className: 'w-32',
      render: (delivery) => (
        <span className="font-mono text-[12px] text-ink-muted">
          {formatDateTime(delivery.createdAt)}
        </span>
      ),
    },
    {
      key: 'delivered',
      header: 'Delivered',
      className: 'w-32',
      // Null for a delivery that exhausted its attempts, which is the row a
      // reader is looking for. An em dash says "never" without claiming a time.
      render: (delivery) => (
        <span className="font-mono text-[12px] text-ink-muted">
          {delivery.deliveredAt === null ? '—' : formatDateTime(delivery.deliveredAt)}
        </span>
      ),
    },
    {
      key: 'payload',
      header: 'Body',
      className: 'w-20',
      render: (delivery) => (
        <button
          type="button"
          onClick={() => {
            setOpenPayloadId((current) => (current === delivery.id ? null : delivery.id))
          }}
          className="text-[12px] font-medium text-accent hover:underline"
        >
          {openPayloadId === delivery.id ? 'Hide' : 'View'}
        </button>
      ),
    },
  ]

  if (deliveries.error !== null) {
    return <ErrorPanel error={deliveries.error} />
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-[12px] font-semibold text-ink">
          Deliveries
          {/* The same constant the engine prunes by, so this cannot promise
              history the engine has already deleted. */}
          <span className="ml-2 font-normal text-ink-faint">
            kept {WEBHOOK_DELIVERY_RETENTION_DAYS} days
          </span>
        </h3>
        <SegmentedControl
          value={status}
          onChange={(next) => {
            setStatus(next)
            // The open body may not be in the filtered list, and a panel left
            // showing a row the table no longer has reads as a mismatch.
            setOpenPayloadId(null)
          }}
          options={STATUS_OPTIONS}
          ariaLabel="Filter deliveries by status"
        />
      </div>

      {deliveries.isLoading ? (
        <LoadingPanel label="Loading deliveries…" />
      ) : deliveries.records.length === 0 ? (
        <p className="text-[12px] text-ink-muted">
          {status === 'all' ? 'Nothing delivered yet.' : `No ${status} deliveries.`}
        </p>
      ) : (
        <DataTable
          columns={columns}
          rows={deliveries.records}
          getRowId={(delivery) => delivery.id}
        />
      )}

      {open !== undefined && <PayloadPanel delivery={open} />}

      {deliveries.hasMore && (
        <button
          type="button"
          onClick={deliveries.loadMore}
          disabled={deliveries.isLoadingMore}
          className="rounded-md border border-border px-3 py-1.5 text-[12px] font-medium text-ink transition hover:border-border-strong hover:bg-surface-sunken disabled:opacity-50"
        >
          {deliveries.isLoadingMore ? 'Loading…' : 'Load more'}
        </button>
      )}
    </div>
  )
}

/**
 * The body of one delivery.
 *
 * Deliberately not called the signed bytes. `payload` is a `jsonb` column, and
 * Postgres reorders an object's keys and drops the whitespace, so what comes
 * back is the content the receiver was sent rather than the exact text the
 * `Kelpie-Signature` HMAC covers. Saying otherwise would send a customer off to
 * verify a signature against a string we never transmitted.
 */
function PayloadPanel({ delivery }: { readonly delivery: WebhookDelivery }): React.JSX.Element {
  return (
    <div className="rounded-md border border-border bg-surface-sunken p-3">
      <p className="text-[11px] text-ink-faint">
        What was sent for <span className="font-mono">{delivery.event}</span>. The database
        normalises key order, so this is the content of the body and not the exact text the
        signature was computed over.
      </p>
      <pre className="mt-2 overflow-x-auto rounded border border-border bg-surface p-3 font-mono text-[11px] text-ink">
        {JSON.stringify(delivery.payload, null, 2)}
      </pre>
    </div>
  )
}
