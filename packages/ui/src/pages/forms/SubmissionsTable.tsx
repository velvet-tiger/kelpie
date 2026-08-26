import type { Form, FormSubmission } from '@kelpie/schemas'
import { useMemo } from 'react'
import { Link } from 'react-router'

import type { RecordListResult } from '../../api/resource.ts'
import { useTimezone } from '../../api/resources/account.ts'
import { useCompanies } from '../../api/resources/companies.ts'
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
 * same way the Decisions page does it: `api.md` has no include-expansion, and
 * neither list takes a set of bare ids. A record past those pages is still
 * linked, by its type rather than its name, which beats a raw id.
 */

/** `api.md`: `?limit=` maxes out at 200. */
const MAX_PAGE = 200

export interface SubmissionsTableProps {
  readonly form: Form
  readonly submissions: RecordListResult<FormSubmission>
}

export function SubmissionsTable({ form, submissions }: SubmissionsTableProps): React.JSX.Element {
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
      key: 'deal',
      header: 'Deal',
      className: 'w-24',
      render: (submission) =>
        submission.dealId === null ? (
          <span className="text-ink-faint">—</span>
        ) : (
          <Link to={`/deals/${submission.dealId}`} className="text-accent hover:underline">
            View
          </Link>
        ),
    },
    {
      key: 'answers',
      header: 'Answers',
      render: (submission) => (
        <span className="text-[12px] text-ink-muted">{summarise(form, submission)}</span>
      ),
    },
  ]

  if (submissions.error !== null) {
    return <ErrorPanel error={submissions.error} />
  }

  if (submissions.isLoading) {
    return <LoadingPanel label="Loading submissions…" />
  }

  return (
    <div>
      <SectionHeader
        title="Submissions"
        description="Inbound answers, and the records each one created or matched."
      />
      <DataTable
        columns={columns}
        rows={submissions.records}
        getRowId={(submission) => submission.id}
        emptyMessage="No submissions yet"
      />
      <Paginator list={submissions} />
    </div>
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
    <Link to={`${to}/${id}`} className="text-accent hover:underline">
      {name.get(id) ?? fallback}
    </Link>
  )
}

/**
 * The first two answers that are not already a column.
 *
 * Name and email are the Person link, so repeating them would spend the row's
 * remaining width saying what it already said. A select shows its label rather
 * than the key that was stored.
 */
function summarise(form: Form, submission: FormSubmission): string {
  const parts = form.fields
    .filter((field) => field.mapTo !== 'person.name' && field.mapTo !== 'person.email')
    .map((field) => {
      const answer = submission.answers[field.id]

      if (answer === undefined || answer.trim().length === 0) {
        return undefined
      }

      const shown =
        field.type === 'select'
          ? (field.options.find((option) => option.key === answer)?.value ?? answer)
          : answer

      return `${field.label}: ${shown}`
    })
    .filter((part): part is string => part !== undefined)
    .slice(0, 2)

  return parts.length === 0 ? '—' : parts.join(' · ')
}
