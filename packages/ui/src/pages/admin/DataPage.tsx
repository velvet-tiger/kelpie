import {
  CONFLICT_MODE_LABELS,
  IMPORT_OBJECTS,
  IMPORT_SOURCES,
  MATCH_KEYS,
  OBJECT_COLUMNS,
  OBJECT_LABELS,
  SOURCE_LABELS,
  defaultMatchKeyId,
  findMatchKey,
  isImportJobSettled,
  requiredColumns,
} from '@kelpie/schemas'
import type {
  ImportColumnMap,
  ImportConflictMode,
  ImportJob,
  ImportObject,
  ImportPreviewRow,
  ImportRowAction,
  ImportSource,
} from '@kelpie/schemas'
import { useState } from 'react'
import type { ChangeEvent, FormEvent, ReactNode } from 'react'

import {
  saveCsv,
  useCommitImportJob,
  useCreateImportJob,
  useDeleteImportJob,
  useExportCsv,
  useImportJob,
} from '../../api/resources/importJobs.ts'
import { PageHeader } from '../../components/PageHeader.tsx'

/**
 * Import and export, ported from the mockup's `/admin/data`.
 *
 * The wizard is the mockup's four steps, with the parsing moved to the server.
 * The mockup read the CSV in the browser to fill its mapping table; here the
 * upload is the first dry run, and the job comes back carrying the file's own
 * headers and the map the server derived. Correcting a mapping re-uploads the
 * same file, which is why the `File` stays in state after the first request.
 *
 * Narrowed from the mockup: no "Load sample" button. It fetched fixtures out of
 * `public/fixtures`, and none of those are part of the application.
 */

type WizardStep = 'source' | 'upload' | 'map' | 'result'

const STEPS: readonly { readonly id: WizardStep; readonly label: string }[] = [
  { id: 'source', label: 'Source' },
  { id: 'upload', label: 'Upload' },
  { id: 'map', label: 'Map' },
  { id: 'result', label: 'Dry-run' },
]

export function DataPage(): ReactNode {
  const [exportObject, setExportObject] = useState<ImportObject>('companies')

  const [step, setStep] = useState<WizardStep>('source')
  const [source, setSource] = useState<ImportSource>('custom')
  const [object, setObject] = useState<ImportObject>('companies')
  const [file, setFile] = useState<File | null>(null)
  const [columnMap, setColumnMap] = useState<ImportColumnMap>({})
  const [conflictMode, setConflictMode] = useState<ImportConflictMode>('skip')
  const [matchKeyId, setMatchKeyId] = useState<string>(() => defaultMatchKeyId('companies'))
  const [jobId, setJobId] = useState<string | undefined>(undefined)
  const [problem, setProblem] = useState<string | null>(null)

  const exportCsv = useExportCsv()
  const createJob = useCreateImportJob()
  const commitJob = useCommitImportJob()
  const deleteJob = useDeleteImportJob()
  const watched = useImportJob(jobId)
  const job = watched.record

  const failure = problem ?? messageOf(exportCsv.error ?? createJob.error ?? commitJob.error ?? watched.error)

  /**
   * Drops a job the wizard is walking away from, so the file stored against it
   * goes too.
   *
   * Every path out of a job leads here, because each one is the same thing: a
   * correction that uploads the file again, a step back, or starting over. None
   * of them can reach the old job afterwards.
   *
   * Fire and forget, and `deleteJob.error` is deliberately left out of `failure`
   * above. The caller has already got what they asked for, and tidying up is not
   * theirs to fix. The one refusal the server makes is a job still committing,
   * and that one settles on its own.
   */
  function discardJob(id: string | undefined): void {
    if (id !== undefined) {
      deleteJob.run(id)
    }
  }

  /**
   * Starts a step that talks to the API and drops its rejection.
   *
   * These steps use `runAsync` because they chain: a refused mapping must not
   * advance the wizard, and only a rejection stops the lines after the await.
   * The failure is already on screen through `failure` above, so the rejection
   * has nothing left to say, and discarding it with a bare `void` would leave an
   * unhandled rejection behind every refused upload.
   */
  function runStep(work: Promise<unknown>): void {
    void work.catch(() => undefined)
  }

  function resetWizard(): void {
    discardJob(jobId)
    setStep('source')
    setFile(null)
    setColumnMap({})
    setConflictMode('skip')
    setMatchKeyId(defaultMatchKeyId(object))
    setJobId(undefined)
    setProblem(null)
  }

  async function onDownload(target: ImportObject, template: boolean): Promise<void> {
    setProblem(null)
    saveCsv(await exportCsv.runAsync({ object: target, template }))
  }

  /** Uploads the file and reads back the headers, the derived map, and the forecast. */
  async function runDryRun(next: File, map: ImportColumnMap | undefined): Promise<ImportJob> {
    const superseded = jobId
    const created = await createJob.runAsync({
      file: next,
      source,
      object,
      conflictMode,
      matchKeyId,
      ...(map === undefined ? {} : { columnMap: map }),
    })

    setJobId(created.id)

    // After the create rather than before it. A map the server rejects throws
    // out of `runAsync`, and the caller is still reading the old job's headers
    // in the mapping table it has to correct.
    discardJob(superseded)

    return created
  }

  async function onFileChange(event: ChangeEvent<HTMLInputElement>): Promise<void> {
    const chosen = event.target.files?.[0]

    // Cleared so choosing the same file twice fires the event again, which is
    // what a caller who fixed the file on disk expects.
    event.target.value = ''

    if (chosen === undefined) {
      return
    }

    setProblem(null)
    setFile(chosen)

    const created = await runDryRun(chosen, undefined)

    // The first upload takes the server's own reading of the file, which is what
    // the mapping table is then built from.
    setColumnMap(created.columnMap)
    setMatchKeyId(created.matchKey)
    setStep('map')
  }

  async function onRerun(event: FormEvent): Promise<void> {
    event.preventDefault()

    if (file === null) {
      return
    }

    const matchKey = findMatchKey(object, matchKeyId)
    const missing =
      matchKey === undefined
        ? []
        : requiredColumns(object, matchKey).filter((column) => (columnMap[column] ?? null) === null)

    if (missing.length > 0) {
      setProblem(`Map these columns first: ${missing.join(', ')}`)
      return
    }

    setProblem(null)
    await runDryRun(file, columnMap)
    setStep('result')
  }

  function onCommit(): void {
    // The file goes back with the commit: the server kept its digest, not its
    // bytes. This is the same `File` every dry run was run against.
    if (jobId === undefined || file === null) {
      return
    }

    setProblem(null)
    commitJob.run({ id: jobId, file })
  }

  return (
    <div className="animate-slide-in space-y-10">
      <PageHeader
        title="Import & export"
        description="CSV for People, Companies, Positions, and Deals. Custom files or HubSpot / Salesforce packs."
      />

      {failure === null ? null : (
        <p role="alert" className="text-[12px] font-medium text-danger">
          {failure}
        </p>
      )}

      <section className="space-y-4">
        <div>
          <h2 className="text-[15px] font-semibold text-ink">Export</h2>
          <p className="mt-1 text-[13px] text-ink-muted">
            Download this workspace as CSV. A Kelpie export reads straight back in with no column
            mapping.
          </p>
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Object">
            <select
              value={exportObject}
              onChange={(event) => setExportObject(event.target.value as ImportObject)}
              className="w-48 rounded-md border border-border bg-surface-raised px-3 py-2 text-[13px] outline-none focus:border-accent"
            >
              {IMPORT_OBJECTS.map((item) => (
                <option key={item} value={item}>
                  {OBJECT_LABELS[item]}
                </option>
              ))}
            </select>
          </Field>
          <button
            type="button"
            onClick={() => runStep(onDownload(exportObject, false))}
            disabled={exportCsv.isPending}
            className="rounded-md bg-accent px-3.5 py-2 text-[12px] font-semibold text-accent-fg transition hover:bg-accent-hover disabled:opacity-50"
          >
            {exportCsv.isPending ? 'Preparing…' : 'Download CSV'}
          </button>
        </div>
      </section>

      <section className="space-y-4 border-t border-border pt-8">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-[15px] font-semibold text-ink">Import</h2>
            <p className="mt-1 text-[13px] text-ink-muted">
              Custom CSV or HubSpot / Salesforce export packs. Every job is dry-run first; nothing is
              written until you commit.
            </p>
          </div>
          {step === 'source' ? null : (
            <button
              type="button"
              onClick={resetWizard}
              className="shrink-0 text-[12px] font-medium text-ink-muted hover:text-ink"
            >
              Start over
            </button>
          )}
        </div>

        <StepIndicator step={step} />

        {step === 'source' ? (
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault()
              setStep('upload')
            }}
          >
            <Field label="Source">
              <select
                value={source}
                onChange={(event) => setSource(event.target.value as ImportSource)}
                className="w-full max-w-md rounded-md border border-border bg-surface-raised px-3 py-2 text-[13px] outline-none focus:border-accent"
              >
                {IMPORT_SOURCES.map((item) => (
                  <option key={item} value={item}>
                    {SOURCE_LABELS[item]}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Object">
              <select
                value={object}
                onChange={(event) => {
                  const next = event.target.value as ImportObject

                  setObject(next)
                  setMatchKeyId(defaultMatchKeyId(next))
                }}
                className="w-full max-w-md rounded-md border border-border bg-surface-raised px-3 py-2 text-[13px] outline-none focus:border-accent"
              >
                {IMPORT_OBJECTS.map((item) => (
                  <option key={item} value={item}>
                    {OBJECT_LABELS[item]}
                  </option>
                ))}
              </select>
            </Field>
            <div className="rounded-md border border-border px-4 py-3">
              <div className="text-[13px] font-medium text-ink">Need a blank file?</div>
              <p className="mt-0.5 text-[12px] text-ink-muted">
                Download a Kelpie CSV template for {OBJECT_LABELS[object].toLowerCase()}, fill it in,
                then continue.
              </p>
              <button
                type="button"
                onClick={() => runStep(onDownload(object, true))}
                className="mt-3 rounded-md border border-border bg-surface px-3.5 py-2 text-[12px] font-semibold text-ink transition hover:border-accent"
              >
                Download template
              </button>
            </div>
            <p className="text-[12px] text-ink-muted">
              Import order for linked data: Companies → People → Positions → Deals.
            </p>
            <button
              type="submit"
              className="rounded-md bg-accent px-3.5 py-2 text-[12px] font-semibold text-accent-fg transition hover:bg-accent-hover"
            >
              Continue
            </button>
          </form>
        ) : null}

        {step === 'upload' ? (
          <div className="space-y-4">
            <p className="text-[13px] text-ink-muted">
              {SOURCE_LABELS[source]} → {OBJECT_LABELS[object]}
            </p>
            <label className="flex cursor-pointer flex-col items-center justify-center rounded-lg border border-dashed border-border bg-surface-raised px-6 py-10 transition hover:border-accent">
              <span className="text-[13px] font-medium text-ink">
                {createJob.isPending ? 'Reading the file…' : 'Drop a CSV here or click to browse'}
              </span>
              <span className="mt-1 text-[12px] text-ink-muted">
                UTF-8 CSV · max 10 MB · max 10,000 rows
              </span>
              <input
                type="file"
                accept=".csv,text/csv"
                className="sr-only"
                disabled={createJob.isPending}
                onChange={(event) => runStep(onFileChange(event))}
              />
            </label>
            <button
              type="button"
              onClick={() => setStep('source')}
              className="rounded-md px-3 py-2 text-[12px] font-medium text-ink-muted hover:text-ink"
            >
              Back
            </button>
          </div>
        ) : null}

        {step === 'map' && job !== undefined ? (
          <MappingForm
            job={job}
            object={object}
            columnMap={columnMap}
            conflictMode={conflictMode}
            matchKeyId={matchKeyId}
            isPending={createJob.isPending}
            onColumnMapChange={setColumnMap}
            onConflictModeChange={setConflictMode}
            onMatchKeyChange={setMatchKeyId}
            onSubmit={(event) => runStep(onRerun(event))}
            onBack={() => {
              discardJob(jobId)
              setFile(null)
              setJobId(undefined)
              setStep('upload')
            }}
          />
        ) : null}

        {step === 'result' && job !== undefined ? (
          <ResultPanel
            job={job}
            object={object}
            isCommitting={commitJob.isPending}
            onCommit={onCommit}
            onBack={() => setStep('map')}
          />
        ) : null}
      </section>
    </div>
  )
}

interface MappingFormProps {
  readonly job: ImportJob
  readonly object: ImportObject
  readonly columnMap: ImportColumnMap
  readonly conflictMode: ImportConflictMode
  readonly matchKeyId: string
  readonly isPending: boolean
  readonly onColumnMapChange: (map: ImportColumnMap) => void
  readonly onConflictModeChange: (mode: ImportConflictMode) => void
  readonly onMatchKeyChange: (id: string) => void
  readonly onSubmit: (event: FormEvent) => void
  readonly onBack: () => void
}

function MappingForm(props: MappingFormProps): ReactNode {
  const matchKey = findMatchKey(props.object, props.matchKeyId)
  const keyColumns = new Set(matchKey?.columns ?? [])

  return (
    <form className="space-y-4" onSubmit={props.onSubmit}>
      <p className="text-[13px] text-ink-muted">
        Mapping <span className="font-medium text-ink">{props.job.fileName ?? 'the file'}</span> (
        {props.job.counts.total} rows). Match Kelpie fields to CSV columns.
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="On match">
          <select
            value={props.conflictMode}
            onChange={(event) => props.onConflictModeChange(event.target.value as ImportConflictMode)}
            className="w-full rounded-md border border-border bg-surface-raised px-3 py-2 text-[13px] outline-none focus:border-accent"
          >
            {Object.entries(CONFLICT_MODE_LABELS).map(([mode, label]) => (
              <option key={mode} value={mode}>
                {label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Key column">
          <select
            value={props.matchKeyId}
            onChange={(event) => props.onMatchKeyChange(event.target.value)}
            className="w-full rounded-md border border-border bg-surface-raised px-3 py-2 text-[13px] outline-none focus:border-accent"
          >
            {MATCH_KEYS[props.object].map((key) => (
              <option key={key.id} value={key.id}>
                {key.label}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <p className="text-[12px] text-ink-muted">
        {props.conflictMode === 'update'
          ? 'Rows matching an existing record on the key column overwrite the fields you map below. A blank cell changes nothing.'
          : 'Rows matching an existing record on the key column are skipped.'}{' '}
        Key columns must be mapped.
      </p>
      <div className="overflow-hidden rounded-md border border-border">
        <table className="w-full text-left text-[13px]">
          <thead>
            <tr className="border-b border-border bg-surface text-[11px] font-semibold tracking-wide text-ink-muted uppercase">
              <th className="px-4 py-2.5">Kelpie field</th>
              <th className="px-4 py-2.5">CSV column</th>
            </tr>
          </thead>
          <tbody>
            {OBJECT_COLUMNS[props.object].map((column) => {
              const isKey = keyColumns.has(column.key)

              return (
                <tr key={column.key} className="border-b border-border last:border-0">
                  <td className="px-4 py-2.5">
                    <span className="font-medium">{column.label}</span>
                    <span className="ml-2 font-mono text-[11px] text-ink-faint">{column.key}</span>
                    {column.required || isKey ? (
                      <span className="ml-2 text-[11px] text-danger">
                        {isKey ? 'key' : 'required'}
                      </span>
                    ) : null}
                  </td>
                  <td className="px-4 py-2.5">
                    <select
                      value={props.columnMap[column.key] ?? ''}
                      onChange={(event) =>
                        props.onColumnMapChange({
                          ...props.columnMap,
                          [column.key]: event.target.value === '' ? null : event.target.value,
                        })
                      }
                      className="w-full max-w-xs rounded-md border border-border bg-surface px-2 py-1.5 text-[13px] outline-none focus:border-accent"
                    >
                      <option value="">— ignore —</option>
                      {props.job.sourceHeaders.map((header) => (
                        <option key={header} value={header}>
                          {header}
                        </option>
                      ))}
                    </select>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      <div className="flex flex-wrap gap-3">
        <button
          type="submit"
          disabled={props.isPending}
          className="rounded-md bg-accent px-3.5 py-2 text-[12px] font-semibold text-accent-fg transition hover:bg-accent-hover disabled:opacity-50"
        >
          {props.isPending ? 'Running…' : 'Run dry-run'}
        </button>
        <button
          type="button"
          onClick={props.onBack}
          className="rounded-md px-3 py-2 text-[12px] font-medium text-ink-muted hover:text-ink"
        >
          Back
        </button>
      </div>
    </form>
  )
}

interface ResultPanelProps {
  readonly job: ImportJob
  readonly object: ImportObject
  readonly isCommitting: boolean
  readonly onCommit: () => void
  readonly onBack: () => void
}

function ResultPanel({ job, object, isCommitting, onCommit, onBack }: ResultPanelProps): ReactNode {
  const working = !isImportJobSettled(job.status)
  const done = job.status === 'completed'
  const nothingToDo = job.counts.create === 0 && job.counts.update === 0

  return (
    <div className="space-y-4">
      <p className="text-[13px] text-ink-muted">
        Job <span className="font-mono text-[12px] text-ink">{job.id}</span> · status {job.status}
        {working ? ' · working…' : null}
      </p>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        <Stat label="Total" value={job.counts.total} />
        <Stat label="Create" value={job.counts.create} />
        <Stat label="Update" value={job.counts.update} />
        <Stat label="Skip" value={job.counts.skip} />
        <Stat label="Error" value={job.counts.error} danger />
      </div>
      <p className="text-[12px] text-ink-muted">
        On match: {CONFLICT_MODE_LABELS[job.conflictMode].toLowerCase()}. Key column:{' '}
        <span className="font-mono text-[11px] text-ink">
          {findMatchKey(object, job.matchKey)?.label ?? job.matchKey}
        </span>
      </p>

      {job.preview.length > 0 ? (
        <div className="space-y-2">
          <div>
            <h3 className="text-[13px] font-semibold text-ink">Mapping preview</h3>
            <p className="mt-0.5 text-[12px] text-ink-muted">
              The first {job.preview.length} row{job.preview.length === 1 ? '' : 's'} as Kelpie read
              them. Go back to mapping if a column looks wrong.
            </p>
          </div>
          <PreviewTable object={object} rows={job.preview} />
        </div>
      ) : null}

      {job.errors.length > 0 ? (
        <div className="space-y-2">
          <div className="overflow-hidden rounded-md border border-border">
            <table className="w-full text-left text-[13px]">
              <thead>
                <tr className="border-b border-border bg-surface text-[11px] font-semibold tracking-wide text-ink-muted uppercase">
                  <th className="px-4 py-2.5">Row</th>
                  <th className="px-4 py-2.5">Field</th>
                  <th className="px-4 py-2.5">Message</th>
                </tr>
              </thead>
              <tbody>
                {job.errors.map((error, index) => (
                  <tr
                    key={`${String(error.row)}-${error.field}-${String(index)}`}
                    className="border-b border-border last:border-0"
                  >
                    <td className="px-4 py-2.5 font-mono text-[12px]">{error.row}</td>
                    <td className="px-4 py-2.5 font-mono text-[12px]">{error.field}</td>
                    <td className="px-4 py-2.5 text-ink-muted">{error.message}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {job.counts.error > job.errors.length ? (
            <p className="text-[12px] text-ink-muted">
              Showing {job.errors.length} of {job.counts.error} failing rows.
            </p>
          ) : null}
        </div>
      ) : (
        <p className="text-[13px] text-ink-muted">No row errors.</p>
      )}

      <div className="flex flex-wrap gap-3">
        <button
          type="button"
          onClick={onCommit}
          disabled={done || working || isCommitting || nothingToDo}
          className="rounded-md bg-accent px-3.5 py-2 text-[12px] font-semibold text-accent-fg transition hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
        >
          {done ? 'Committed' : isCommitting || working ? 'Working…' : 'Commit import'}
        </button>
        <button
          type="button"
          onClick={onBack}
          className="rounded-md px-3 py-2 text-[12px] font-medium text-ink-muted hover:text-ink"
        >
          Back to mapping
        </button>
      </div>
    </div>
  )
}

function PreviewTable({
  object,
  rows,
}: {
  readonly object: ImportObject
  readonly rows: readonly ImportPreviewRow[]
}): ReactNode {
  const keys = OBJECT_COLUMNS[object]
    .map((column) => column.key)
    .filter((key) => rows.some((row) => key in row.values))

  return (
    <div className="overflow-x-auto rounded-md border border-border">
      <table className="w-full min-w-[36rem] text-left text-[13px]">
        <thead>
          <tr className="border-b border-border bg-surface text-[11px] font-semibold tracking-wide text-ink-muted uppercase">
            <th className="px-3 py-2.5">Row</th>
            <th className="px-3 py-2.5">Action</th>
            {keys.map((key) => (
              <th key={key} className="px-3 py-2.5 font-mono normal-case">
                {key}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.row} className="border-b border-border last:border-0">
              <td className="px-3 py-2.5 font-mono text-[12px] text-ink-muted">{row.row}</td>
              <td className="px-3 py-2.5">
                <ActionChip action={row.action} />
              </td>
              {keys.map((key) => (
                <td
                  key={key}
                  className="max-w-[12rem] truncate px-3 py-2.5 text-ink"
                  title={row.values[key] ?? ''}
                >
                  {row.values[key] === undefined || row.values[key] === '' ? (
                    <span className="text-ink-faint">—</span>
                  ) : (
                    row.values[key]
                  )}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

const ACTION_STYLES: Readonly<Record<ImportRowAction, string>> = {
  pending: 'bg-surface text-ink-faint',
  create: 'bg-accent/15 text-accent-hover',
  update: 'bg-warning-soft text-warning',
  skip: 'bg-surface text-ink-muted',
  error: 'bg-danger-soft text-danger',
}

function ActionChip({ action }: { readonly action: ImportRowAction }): ReactNode {
  return (
    <span
      className={[
        'inline-block rounded px-1.5 py-0.5 text-[11px] font-semibold uppercase',
        ACTION_STYLES[action],
      ].join(' ')}
    >
      {action}
    </span>
  )
}

function StepIndicator({ step }: { readonly step: WizardStep }): ReactNode {
  const active = STEPS.findIndex((item) => item.id === step)

  return (
    <ol className="flex flex-wrap gap-2 text-[12px]">
      {STEPS.map((item, index) => (
        <li
          key={item.id}
          className={[
            'rounded-md px-2.5 py-1 font-medium',
            index === active
              ? 'bg-accent/15 text-accent-hover'
              : index < active
                ? 'text-ink'
                : 'text-ink-faint',
          ].join(' ')}
        >
          {index + 1}. {item.label}
        </li>
      ))}
    </ol>
  )
}

function Stat({
  label,
  value,
  danger,
}: {
  readonly label: string
  readonly value: number
  readonly danger?: boolean
}): ReactNode {
  return (
    <div className="rounded-md border border-border px-3 py-2.5">
      <div className="text-[11px] font-semibold tracking-wide text-ink-muted uppercase">{label}</div>
      <div
        className={[
          'mt-1 text-[20px] font-semibold tabular-nums',
          danger === true && value > 0 ? 'text-danger' : 'text-ink',
        ].join(' ')}
      >
        {value}
      </div>
    </div>
  )
}

function Field({
  label,
  children,
}: {
  readonly label: string
  readonly children: ReactNode
}): ReactNode {
  return (
    <label className="block">
      <span className="mb-1.5 block text-[12px] font-medium text-ink">{label}</span>
      {children}
    </label>
  )
}

function messageOf(error: Error | null | undefined): string | null {
  return error === null || error === undefined ? null : error.message
}
