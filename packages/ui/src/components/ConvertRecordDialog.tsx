import {
  PIPELINE_KINDS,
  PIPELINE_KIND_LABELS,
} from '@kelpie/schemas'
import type { ConvertPipelineRecordInput, PipelineKind } from '@kelpie/schemas'
import { useState } from 'react'
import { Link } from 'react-router'

import { useCompanies } from '../api/resources/companies.ts'
import type { MutationResult } from '../api/resource.ts'
import {
  detailPathForPipelineKind,
  type ConvertPipelineRecordArguments,
  type ConvertedPipelineRecord,
} from '../api/resources/conversions.ts'

const COMPANY_REQUIRED_TARGETS = new Set<PipelineKind>(['deal', 'raise', 'partnership'])

export interface ConvertRecordDialogProps {
  readonly sourceKind: PipelineKind
  readonly recordName: string
  readonly companyId: string | null
  readonly isPending: boolean
  readonly onCancel: () => void
  readonly onConfirm: (body: ConvertPipelineRecordInput) => void
}

export function ConvertRecordDialog({
  sourceKind,
  recordName,
  companyId,
  isPending,
  onCancel,
  onConfirm,
}: ConvertRecordDialogProps): React.JSX.Element {
  const targetOptions = PIPELINE_KINDS.filter((kind) => kind !== sourceKind)
  const [targetType, setTargetType] = useState<PipelineKind>(targetOptions[0] ?? 'deal')
  const [kind, setKind] = useState('')
  const [selectedCompanyId, setSelectedCompanyId] = useState(companyId ?? '')
  const companies = useCompanies({ limit: 100 })

  const needsCompany = COMPANY_REQUIRED_TARGETS.has(targetType) && companyId === null
  const needsKind = targetType === 'opportunity' || targetType === 'partnership'

  return (
    <div className="rounded-md border border-border bg-surface-raised p-4">
      <p className="text-[13px] text-ink">
        Convert <span className="font-semibold">{recordName}</span> to another record type. This
        creates a new record, moves notes / activity / plans / decisions to it, copies linked people,
        and leaves this record in place with a link.
      </p>

      <div className="mt-4 space-y-3">
        <label className="block text-[12px] font-medium text-ink-muted">
          Convert to
          <select
            value={targetType}
            onChange={(event) => {
              setTargetType(event.target.value as PipelineKind)
            }}
            className="mt-1 block w-full rounded-md border border-border bg-surface px-2.5 py-1.5 text-[13px] text-ink"
          >
            {targetOptions.map((kind) => (
              <option key={kind} value={kind}>
                {PIPELINE_KIND_LABELS[kind]}
              </option>
            ))}
          </select>
        </label>

        {needsKind && (
          <label className="block text-[12px] font-medium text-ink-muted">
            Kind
            <input
              value={kind}
              onChange={(event) => {
                setKind(event.target.value)
              }}
              className="mt-1 block w-full rounded-md border border-border bg-surface px-2.5 py-1.5 text-[13px] text-ink"
              placeholder={targetType === 'opportunity' ? 'Grant' : 'Integration'}
            />
          </label>
        )}

        {needsCompany && (
          <label className="block text-[12px] font-medium text-ink-muted">
            Company
            <select
              value={selectedCompanyId}
              onChange={(event) => {
                setSelectedCompanyId(event.target.value)
              }}
              className="mt-1 block w-full rounded-md border border-border bg-surface px-2.5 py-1.5 text-[13px] text-ink"
            >
              <option value="">Choose a company…</option>
              {companies.records.map((company) => (
                <option key={company.id} value={company.id}>
                  {company.name}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>

      <div className="mt-4 flex justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          disabled={isPending}
          className="rounded-md px-2.5 py-1 text-[12px] font-medium text-ink-muted hover:text-ink disabled:opacity-50"
        >
          Cancel
        </button>
        <button
          type="button"
          disabled={isPending || (needsCompany && selectedCompanyId.length === 0)}
          onClick={() => {
            onConfirm({
              targetType,
              ...(needsKind && kind.length > 0 ? { kind } : {}),
              ...(needsCompany ? { companyId: selectedCompanyId } : {}),
            })
          }}
          className="rounded-md bg-accent px-3 py-1.5 text-[12px] font-semibold text-accent-fg hover:bg-accent-hover disabled:opacity-50"
        >
          {isPending ? 'Converting…' : 'Convert'}
        </button>
      </div>
    </div>
  )
}

export interface ConvertRecordActionProps {
  readonly sourceKind: PipelineKind
  readonly recordId: string
  readonly recordName: string
  readonly companyId: string | null
  readonly convertedTo: { readonly targetType: PipelineKind; readonly targetId: string } | null
  readonly convert: MutationResult<ConvertPipelineRecordArguments, ConvertedPipelineRecord>
  readonly onConverted: (record: ConvertedPipelineRecord, targetType: PipelineKind) => void
  readonly showDialog: boolean
  readonly onOpenDialog: () => void
  readonly onCloseDialog: () => void
}

export function ConvertRecordButton({
  convertedTo,
  convert,
  onOpenDialog,
}: Pick<
  ConvertRecordActionProps,
  'convertedTo' | 'convert' | 'onOpenDialog'
>): React.JSX.Element {
  if (convertedTo !== null) {
    return (
      <Link
        to={detailPathForPipelineKind(convertedTo.targetType, convertedTo.targetId)}
        className="rounded-md border border-border px-2.5 py-1 text-[12px] font-medium text-accent transition hover:border-accent hover:underline"
      >
        Converted — view {PIPELINE_KIND_LABELS[convertedTo.targetType].toLowerCase()}
      </Link>
    )
  }

  return (
    <button
      type="button"
      onClick={onOpenDialog}
      disabled={convert.isPending}
      className="rounded-md border border-border px-2.5 py-1 text-[12px] font-medium text-ink-muted transition hover:border-accent hover:text-accent disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:border-border disabled:hover:text-ink-muted"
    >
      Convert…
    </button>
  )
}

export function ConvertRecordAction({
  sourceKind,
  recordId,
  recordName,
  companyId,
  convert,
  onConverted,
  showDialog,
  onCloseDialog,
}: ConvertRecordActionProps): React.JSX.Element | null {
  if (!showDialog) {
    return null
  }

  return (
    <ConvertRecordDialog
      sourceKind={sourceKind}
      recordName={recordName}
      companyId={companyId}
      isPending={convert.isPending}
      onCancel={onCloseDialog}
      onConfirm={(body) => {
        convert
          .runAsync({ id: recordId, body })
          .then((record) => {
            onCloseDialog()
            onConverted(record, body.targetType)
          })
          .catch(() => undefined)
      }}
    />
  )
}
