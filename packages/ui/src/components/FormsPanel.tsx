import type { FormSubmissionLinkTarget } from '@kelpie/schemas'
import { useMemo } from 'react'
import { Link } from 'react-router'

import { useTimezone } from '../api/resources/account.ts'
import { useForms, useFormSubmissionsForRecord } from '../api/resources/forms.ts'
import { formatDateTime } from '../lib/dates.ts'
import { ErrorPanel, LoadingPanel } from './QueryState.tsx'
import { SectionHeader } from './SectionHeader.tsx'

/**
 * "Which forms touched this record?" panel, for any record's detail page.
 *
 * A submission's FK to this record is what puts it here — the record was
 * either created by the form, or matched from an earlier upsert. The panel
 * does not distinguish the two (nothing on the row tells them apart), and
 * the section header reflects that.
 *
 * Form names are pulled from `useForms`, which the sidebar already caches;
 * an unresolved id (deleted form) falls back to the id itself so the row
 * stays clickable.
 */
export function FormsPanel({
  targetType,
  targetId,
}: {
  readonly targetType: FormSubmissionLinkTarget
  readonly targetId: string
}): React.JSX.Element {
  const submissions = useFormSubmissionsForRecord(targetType, targetId)
  const forms = useForms({})
  const timezone = useTimezone()
  const formNameById = useMemo(
    () => new Map(forms.records.map((form) => [form.id, form.name])),
    [forms.records],
  )

  if (submissions.error !== null) {
    return <ErrorPanel error={submissions.error} />
  }

  if (submissions.isLoading) {
    return <LoadingPanel label="Loading form submissions…" />
  }

  return (
    <section>
      <SectionHeader
        title="Forms"
        description="Every form submission that named this record."
      />

      {submissions.records.length === 0 ? (
        <p className="text-[13px] text-ink-faint">No form submissions yet.</p>
      ) : (
        <ul className="divide-y divide-border rounded-md border border-border">
          {submissions.records.map((submission) => {
            const formName = formNameById.get(submission.formId) ?? submission.formId

            return (
              <li key={submission.id} className="flex items-center justify-between gap-3 p-3">
                <div className="min-w-0">
                  <Link
                    to={`/forms/${submission.formId}/submissions/${submission.id}`}
                    className="text-[13px] font-medium text-ink hover:text-accent"
                  >
                    {formName}
                  </Link>
                  <div className="text-[11px] text-ink-faint">
                    Submitted {formatDateTime(submission.submittedAt, timezone)}
                  </div>
                </div>
                <Link
                  to={`/forms/${submission.formId}`}
                  className="shrink-0 text-[11px] font-medium text-ink-muted hover:text-accent"
                >
                  Open form →
                </Link>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
