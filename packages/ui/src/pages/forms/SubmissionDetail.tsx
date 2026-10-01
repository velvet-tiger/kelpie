import { FORM_SPAM_REASON_LABELS, formFieldDisplayLabel } from '@kelpie/schemas'
import type { Form, FormField, FormSubmission, FormSubmissionActionEntry } from '@kelpie/schemas'
import { useMemo } from 'react'
import { Link, useParams } from 'react-router'

import { useTimezone } from '../../api/resources/account.ts'
import { useCompanies } from '../../api/resources/companies.ts'
import {
  useForm,
  useFormSubmission,
  useReleaseFormSubmission,
} from '../../api/resources/forms.ts'
import { usePeople } from '../../api/resources/people.ts'
import { ErrorPanel, LoadingPanel, NotFoundPanel } from '../../components/QueryState.tsx'
import { SectionHeader } from '../../components/SectionHeader.tsx'
import { formatDateTime } from '../../lib/dates.ts'

/**
 * One submission: every answer, the records it linked, and the action log.
 *
 * Nested under the form so the field labels (which live on the form, not the
 * submission) are at hand, and so "back" returns to that form's Submissions tab
 * rather than the forms list.
 */

/** `?limit=` maxes out at 200 (`docs/agents/api-and-webhooks.md`). */
const MAX_PAGE = 200

export function SubmissionDetail(): React.JSX.Element {
  const { id: formId, submissionId } = useParams()
  const form = useForm(formId)
  const submission = useFormSubmission(formId, submissionId)
  const people = usePeople({ limit: MAX_PAGE })
  const companies = useCompanies({ limit: MAX_PAGE })
  const timezone = useTimezone()

  const nameById = useMemo(
    () => new Map([...people.records, ...companies.records].map((record) => [record.id, record.name])),
    [people.records, companies.records],
  )

  if (form.isNotFound || submission.isNotFound) {
    return (
      <NotFoundPanel
        label="Submission"
        backTo={formId === undefined ? '/forms' : `/forms/${formId}`}
      />
    )
  }

  if (form.error !== null) {
    return <ErrorPanel error={form.error} />
  }

  if (submission.error !== null) {
    return <ErrorPanel error={submission.error} />
  }

  if (
    form.isLoading ||
    submission.isLoading ||
    form.record === undefined ||
    submission.record === undefined
  ) {
    return <LoadingPanel label="Loading submission…" />
  }

  return (
    <SubmissionDetailView
      form={form.record}
      submission={submission.record}
      nameById={nameById}
      timezone={timezone}
    />
  )
}

function SubmissionDetailView({
  form,
  submission,
  nameById,
  timezone,
}: {
  readonly form: Form
  readonly submission: FormSubmission
  readonly nameById: ReadonlyMap<string, string>
  readonly timezone: string
}): React.JSX.Element {
  const answers = form.fields.map((field) => ({
    field,
    value: displayAnswer(field, submission.answers[field.id]),
  }))

  return (
    <div className="animate-fade-in mx-auto max-w-2xl">
      <Link
        to={`/forms/${form.id}`}
        className="mb-4 inline-flex text-[12px] font-medium text-ink-muted transition hover:text-accent"
      >
        ← {form.name}
      </Link>

      <SectionHeader
        title="Submission"
        description={`Received ${formatDateTime(submission.submittedAt, timezone)}.`}
      />

      <SpamNotice form={form} submission={submission} />

      <div className="mt-6 space-y-6">
        <section>
          <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-ink-faint">
            Answers
          </h3>
          <dl className="divide-y divide-border rounded-md border border-border">
            {answers.map(({ field, value }) => (
              <div
                key={field.id}
                className="grid gap-0.5 px-3 py-2.5 sm:grid-cols-[10rem_1fr] sm:gap-3"
              >
                <dt className="text-[12px] font-medium text-ink-muted">
                  {formFieldDisplayLabel(field)}
                  {field.required && <span className="ml-0.5 text-danger">*</span>}
                </dt>
                <dd className="whitespace-pre-wrap text-[13px] text-ink">
                  {value === null ? <span className="text-ink-faint">—</span> : value}
                </dd>
              </div>
            ))}
          </dl>
        </section>

        <section>
          <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-ink-faint">
            Records
          </h3>
          <ul className="space-y-1.5 rounded-md border border-border px-3 py-2.5 text-[13px]">
            <RecordRow
              label="Person"
              to={submission.personId === null ? null : `/people/${submission.personId}`}
              text={
                submission.personId === null
                  ? null
                  : (nameById.get(submission.personId) ?? 'Person')
              }
            />
            <RecordRow
              label="Company"
              to={submission.companyId === null ? null : `/companies/${submission.companyId}`}
              text={
                submission.companyId === null
                  ? null
                  : (nameById.get(submission.companyId) ?? 'Company')
              }
            />
            <RecordRow
              label="Deal"
              to={submission.dealId === null ? null : `/deals/${submission.dealId}`}
              text={submission.dealId === null ? null : 'Open deal'}
            />
            <RecordRow
              label="Opportunity"
              to={
                submission.opportunityId === null
                  ? null
                  : `/opportunities/${submission.opportunityId}`
              }
              text={submission.opportunityId === null ? null : 'Open opportunity'}
            />
            <RecordRow
              label="Partnership"
              to={
                submission.partnershipId === null
                  ? null
                  : `/partnerships/${submission.partnershipId}`
              }
              text={submission.partnershipId === null ? null : 'Open partnership'}
            />
            <RecordRow
              label="Enquiry"
              to={submission.enquiryId === null ? null : `/enquiries/${submission.enquiryId}`}
              text={submission.enquiryId === null ? null : 'Open enquiry'}
            />
          </ul>
        </section>

        {submission.actionLog.length > 0 && (
          <section>
            <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-ink-faint">
              Action log
            </h3>
            <ul className="divide-y divide-border rounded-md border border-border">
              {submission.actionLog.map((entry, index) => (
                <li key={`${entry.action}-${String(index)}`} className="px-3 py-2.5">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="font-mono text-[12px] text-ink">{entry.action}</span>
                    <ActionStatus status={entry.status} />
                  </div>
                  {entry.detail.length > 0 && (
                    <p className="mt-1 text-[12px] text-ink-muted">{entry.detail}</p>
                  )}
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </div>
  )
}

/**
 * What the spam check said about this submission, and the way out.
 *
 * A held submission shows the reason and a Release button. One a person
 * released keeps its reason, so the page says where it came from.
 */
function SpamNotice({
  form,
  submission,
}: {
  readonly form: Form
  readonly submission: FormSubmission
}): React.JSX.Element | null {
  const release = useReleaseFormSubmission()

  if (submission.spamReason === null) {
    return null
  }

  const reason = FORM_SPAM_REASON_LABELS[submission.spamReason]

  if (submission.status !== 'spam') {
    return (
      <p className="mt-4 rounded-md border border-border bg-surface px-3 py-2 text-[12px] text-ink-muted">
        The spam check held this submission, and a person released it. Reason it was held:{' '}
        {reason}.
      </p>
    )
  }

  return (
    <div className="mt-4 rounded-md border border-warning/40 bg-warning-soft px-3 py-2.5">
      <p className="text-[13px] font-medium text-ink">Held as spam</p>
      <p className="mt-0.5 text-[12px] text-ink-muted">
        {reason}. Nothing was written to your CRM and no email was sent. If a person sent
        this, release it: Kelpie then processes it as a normal submission.
      </p>
      {release.error !== null && (
        <div className="mt-2">
          <ErrorPanel error={release.error} />
        </div>
      )}
      <button
        type="button"
        disabled={release.isPending}
        onClick={() => {
          release.run({ formId: form.id, submissionId: submission.id })
        }}
        className="mt-2 rounded-md bg-accent px-2.5 py-1 text-[12px] font-semibold text-accent-fg transition hover:bg-accent-hover disabled:opacity-50"
      >
        {release.isPending ? 'Releasing…' : 'Release'}
      </button>
    </div>
  )
}

function RecordRow({
  label,
  to,
  text,
}: {
  readonly label: string
  readonly to: string | null
  readonly text: string | null
}): React.JSX.Element {
  return (
    <li className="flex items-baseline gap-2 py-0.5">
      <span className="w-28 shrink-0 text-[12px] font-medium text-ink-muted">{label}</span>
      {to === null || text === null ? (
        <span className="text-ink-faint">—</span>
      ) : (
        <Link to={to} className="text-accent hover:underline">
          {text}
        </Link>
      )}
    </li>
  )
}

function ActionStatus({
  status,
}: {
  readonly status: FormSubmissionActionEntry['status']
}): React.JSX.Element {
  const className =
    status === 'ok' ? 'text-success' : status === 'error' ? 'text-danger' : 'text-ink-faint'

  return <span className={`text-[11px] font-medium uppercase ${className}`}>{status}</span>
}

function displayAnswer(field: FormField, answer: string | undefined): string | null {
  if (answer === undefined || answer.trim().length === 0) {
    return null
  }

  if (field.type === 'select') {
    return field.options.find((option) => option.key === answer)?.value ?? answer
  }

  return answer
}
