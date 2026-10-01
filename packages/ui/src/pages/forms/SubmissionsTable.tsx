import { FORM_SPAM_REASON_LABELS, formFieldDisplayLabel } from '@kelpie/schemas'
import type {
  Form,
  FormSubmission,
  FormSubmissionActionEntry,
  FormSubmissionStatus,
} from '@kelpie/schemas'
import { useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router'

import type { RecordListResult } from '../../api/resource.ts'
import { useTimezone } from '../../api/resources/account.ts'
import { useCompanies } from '../../api/resources/companies.ts'
import { useReleaseFormSubmission } from '../../api/resources/forms.ts'
import { usePeople } from '../../api/resources/people.ts'
import { DataTable } from '../../components/DataTable.tsx'
import type { Column } from '../../components/DataTable.tsx'
import { Paginator } from '../../components/Paginator.tsx'
import { ErrorPanel, LoadingPanel } from '../../components/QueryState.tsx'
import { SectionHeader } from '../../components/SectionHeader.tsx'
import { formatDateTime } from '../../lib/dates.ts'

/**
 * What has arrived through this form.
 *
 * Person and company names are joined client-side against one page each, the
 * same way the Decisions page does it: the API has no include-expansion, and
 * neither list filters on its own `?id=` (the repeatable id filters match a
 * foreign key, not the record's id). A record past those pages is still
 * linked, by its type rather than its name, which beats a raw id.
 *
 * A row opens `/forms/:id/submissions/:submissionId`. Inline person/company
 * links still navigate, and stop the row click so opening a person does not
 * also open the submission.
 *
 * What the spam check held is a second list, behind the Spam button. Those rows
 * link no records, so they show the reason and a Release button in place of the
 * person and company.
 */

/** `?limit=` maxes out at 200 (`docs/agents/api-and-webhooks.md`). */
const MAX_PAGE = 200

export interface SubmissionsTableProps {
  readonly form: Form
  readonly submissions: RecordListResult<FormSubmission>
  /** The submissions the spam check held. */
  readonly spam: RecordListResult<FormSubmission>
}

export function SubmissionsTable({
  form,
  submissions,
  spam,
}: SubmissionsTableProps): React.JSX.Element {
  const [view, setView] = useState<FormSubmissionStatus>('accepted')
  const release = useReleaseFormSubmission()
  const navigate = useNavigate()
  const people = usePeople({ limit: MAX_PAGE })
  const companies = useCompanies({ limit: MAX_PAGE })
  const timezone = useTimezone()

  const nameById = useMemo(
    () => new Map([...people.records, ...companies.records].map((record) => [record.id, record.name])),
    [people.records, companies.records],
  )

  const columns: readonly Column<FormSubmission>[] = [
    {
      key: 'submitted',
      header: 'Submitted',
      className: 'w-40',
      render: (submission) => (
        <span className="font-mono text-[12px] text-ink-muted">
          {formatDateTime(submission.submittedAt, timezone)}
        </span>
      ),
    },
    {
      key: 'person',
      header: 'Person',
      render: (submission) => (
        <RecordLink to="/people" id={submission.personId} name={nameById} fallback="Person" />
      ),
    },
    {
      key: 'company',
      header: 'Company',
      render: (submission) => (
        <RecordLink to="/companies" id={submission.companyId} name={nameById} fallback="Company" />
      ),
    },
    {
      key: 'created',
      header: 'Created',
      className: 'w-40',
      render: (submission) => (
        <div className="flex flex-wrap gap-2 text-[12px]">
          <CreatedLink to={`/deals/${submission.dealId ?? ''}`} id={submission.dealId} label="deal" />
          <CreatedLink
            to={`/opportunities/${submission.opportunityId ?? ''}`}
            id={submission.opportunityId}
            label="opp"
          />
          <CreatedLink
            to={`/partnerships/${submission.partnershipId ?? ''}`}
            id={submission.partnershipId}
            label="prt"
          />
          {submission.dealId === null &&
            submission.opportunityId === null &&
            submission.partnershipId === null && <span className="text-ink-faint">—</span>}
        </div>
      ),
    },
    {
      key: 'actions',
      header: 'Actions',
      className: 'w-32',
      render: (submission) => <ActionLogChip entries={submission.actionLog} />,
    },
    {
      key: 'answers',
      header: 'Answers',
      render: (submission) => (
        <span className="text-[12px] text-ink-muted">{summarise(form, submission)}</span>
      ),
    },
  ]

  const spamColumns: readonly Column<FormSubmission>[] = [
    ...columns.filter((column) => column.key === 'submitted'),
    {
      key: 'reason',
      header: 'Why it was held',
      render: (submission) => (
        <span className="text-[12px] text-ink-muted">
          {submission.spamReason === null ? '—' : FORM_SPAM_REASON_LABELS[submission.spamReason]}
        </span>
      ),
    },
    {
      key: 'answers',
      header: 'Answers',
      render: (submission) => (
        <span className="text-[12px] text-ink-muted">
          {summarise(form, submission, NO_TARGETS)}
        </span>
      ),
    },
    {
      key: 'release',
      header: '',
      className: 'w-24 text-right',
      render: (submission) => (
        <button
          type="button"
          disabled={release.isPending}
          onClick={(event) => {
            event.stopPropagation()
            release.run({ formId: form.id, submissionId: submission.id })
          }}
          className="rounded-md border border-border bg-surface-raised px-2.5 py-1 text-[12px] font-medium text-ink transition hover:bg-surface disabled:opacity-50"
        >
          Release
        </button>
      ),
    },
  ]

  const list = view === 'spam' ? spam : submissions

  if (list.error !== null) {
    return <ErrorPanel error={list.error} />
  }

  if (list.isLoading) {
    return <LoadingPanel label="Loading submissions…" />
  }

  return (
    <div>
      <SectionHeader
        title="Submissions"
        description={
          view === 'spam'
            ? 'Submissions the spam check held. Nothing was written to your CRM. Release one to process it as a normal submission. A held submission is deleted after 30 days.'
            : 'Inbound answers, and the records each one created or matched. Click a row to open it.'
        }
      />
      <div className="mb-3 flex gap-1" role="group" aria-label="Which submissions to show">
        <ViewButton active={view === 'accepted'} onClick={() => setView('accepted')}>
          Accepted
        </ViewButton>
        <ViewButton active={view === 'spam'} onClick={() => setView('spam')}>
          Spam{spam.records.length > 0 ? ` (${String(spam.records.length)})` : ''}
        </ViewButton>
      </div>
      {release.error !== null && (
        <div className="mb-3">
          <ErrorPanel error={release.error} />
        </div>
      )}
      <Paginator list={list} placement="top" />
      <DataTable
        columns={view === 'spam' ? spamColumns : columns}
        rows={list.records}
        getRowId={(submission) => submission.id}
        emptyMessage={view === 'spam' ? 'No submissions held as spam' : 'No submissions yet'}
        onRowClick={(submission) => {
          void navigate(`/forms/${form.id}/submissions/${submission.id}`)
        }}
      />
      <Paginator list={list} />
    </div>
  )
}

function ViewButton({
  active,
  onClick,
  children,
}: {
  readonly active: boolean
  readonly onClick: () => void
  readonly children: React.ReactNode
}): React.JSX.Element {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={`rounded-md px-2.5 py-1 text-[12px] font-medium transition ${
        active ? 'bg-accent-soft text-accent' : 'text-ink-muted hover:bg-surface hover:text-ink'
      }`}
    >
      {children}
    </button>
  )
}

function CreatedLink({
  to,
  id,
  label,
}: {
  readonly to: string
  readonly id: string | null
  readonly label: string
}): React.JSX.Element | null {
  if (id === null) {
    return null
  }

  return (
    <Link
      to={to}
      className="text-accent hover:underline"
      onClick={(event) => {
        event.stopPropagation()
      }}
    >
      {label}
    </Link>
  )
}

function ActionLogChip({
  entries,
}: {
  readonly entries: readonly FormSubmissionActionEntry[]
}): React.JSX.Element {
  if (entries.length === 0) {
    return <span className="text-ink-faint">—</span>
  }

  const errors = entries.filter((entry) => entry.status === 'error').length
  const skipped = entries.filter((entry) => entry.status === 'skipped').length
  const ok = entries.length - errors - skipped
  const detail = entries
    .map((entry) => `${entry.action}: ${entry.status}${entry.detail.length > 0 ? ` — ${entry.detail}` : ''}`)
    .join('\n')

  return (
    <span title={detail} className="inline-flex gap-1 font-mono text-[11px] text-ink-muted">
      {ok > 0 && <span className="text-success">✓{ok}</span>}
      {skipped > 0 && <span className="text-ink-faint">−{skipped}</span>}
      {errors > 0 && <span className="text-danger">!{errors}</span>}
    </span>
  )
}

function RecordLink({
  to,
  id,
  name,
  fallback,
}: {
  readonly to: string
  readonly id: string | null
  readonly name: ReadonlyMap<string, string>
  readonly fallback: string
}): React.JSX.Element {
  if (id === null) {
    return <span className="text-ink-faint">—</span>
  }

  return (
    <Link
      to={`${to}/${id}`}
      className="text-accent hover:underline"
      onClick={(event) => {
        event.stopPropagation()
      }}
    >
      {name.get(id) ?? fallback}
    </Link>
  )
}

/**
 * Every target whose answer the row already shows in its own column: the Person
 * link. A form asks for a name as one box or as a first and last pair, and
 * either way the answers are what the Person column is already displaying.
 */
const PERSON_COLUMN_TARGETS: ReadonlySet<string> = new Set([
  'person.name',
  'person.first_name',
  'person.last_name',
  'person.email',
])

const NO_TARGETS: ReadonlySet<string> = new Set()

/**
 * The first two answers that are not already a column.
 *
 * Name and email are the Person link, so repeating them would spend the row's
 * remaining width saying what it already said. A select shows its label rather
 * than the key that was stored. A held submission has no Person link, so it
 * passes `NO_TARGETS` and its name and email are the first two answers.
 */
function summarise(
  form: Form,
  submission: FormSubmission,
  shown: ReadonlySet<string> = PERSON_COLUMN_TARGETS,
): string {
  const parts = form.fields
    .filter((field) => !shown.has(field.mapTo))
    .map((field) => {
      const answer = submission.answers[field.id]

      if (answer === undefined || answer.trim().length === 0) {
        return undefined
      }

      const shown =
        field.type === 'select'
          ? (field.options.find((option) => option.key === answer)?.value ?? answer)
          : answer

      return `${formFieldDisplayLabel(field)}: ${shown}`
    })
    .filter((part): part is string => part !== undefined)
    .slice(0, 2)

  return parts.length === 0 ? '—' : parts.join(' · ')
}
