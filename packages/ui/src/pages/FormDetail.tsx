import type { Form } from '@kelpie/schemas'
import { useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router'

import { useDeleteForm, useForm, useFormSubmissions, useUpdateForm } from '../api/resources/forms.ts'
import { Chip } from '../components/Chip.tsx'
import { DeleteRecord } from '../components/DeleteRecord.tsx'
import { InlineEdit } from '../components/InlineEdit.tsx'
import { ErrorPanel, LoadingPanel, NotFoundPanel } from '../components/QueryState.tsx'
import { RecordTabs } from '../components/RecordTabs.tsx'
import { EmbedPanel } from './forms/EmbedPanel.tsx'
import { FieldsEditor } from './forms/FieldsEditor.tsx'
import { FormSettings } from './forms/FormSettings.tsx'
import { SubmissionsTable } from './forms/SubmissionsTable.tsx'

/**
 * One form: what it collects, what it does with it, and what has arrived.
 *
 * The name and description edit in place like every other record. The field list
 * does not, and the Fields tab says why: a write replaces the whole list, so
 * committing per keystroke would rewrite every field on every character.
 */

type FormTab = 'submissions' | 'fields' | 'settings' | 'embed'

export function FormDetail(): React.JSX.Element {
  const { id } = useParams()
  const navigate = useNavigate()
  const [tab, setTab] = useState<FormTab>('submissions')
  const { record, isLoading, isNotFound, error } = useForm(id)
  const submissions = useFormSubmissions(id)
  const deleteForm = useDeleteForm()

  if (isNotFound) {
    return <NotFoundPanel label="Form" backTo="/forms" />
  }

  if (error !== null) {
    return <ErrorPanel error={error} />
  }

  if (isLoading || record === undefined) {
    return <LoadingPanel label="Loading form…" />
  }

  return (
    <div className="animate-fade-in mx-auto max-w-5xl">
      <Link
        to="/forms"
        className="mb-4 inline-flex text-[12px] font-medium text-ink-muted transition hover:text-accent"
      >
        ← Forms
      </Link>

      <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <FormHeading form={record} />
        <DeleteRecord
          recordLabel="Form"
          recordName={record.name}
          isPending={deleteForm.isPending}
          error={deleteForm.error}
          onConfirm={() => {
            deleteForm
              .runAsync(record.id)
              .then(() => navigate('/forms'))
              .catch(() => undefined)
          }}
        />
      </div>

      <RecordTabs
        tabs={[
          { id: 'submissions', label: 'Submissions', count: submissions.records.length },
          { id: 'fields', label: 'Fields', count: record.fields.length },
          { id: 'settings', label: 'Settings' },
          { id: 'embed', label: 'Embed' },
        ]}
        active={tab}
        onChange={setTab}
        ariaLabel="Form sections"
      >
        {tab === 'submissions' && <SubmissionsTable form={record} submissions={submissions} />}
        {tab === 'fields' && <FieldsEditor form={record} />}
        {tab === 'settings' && <FormSettings form={record} />}
        {tab === 'embed' && <EmbedPanel form={record} />}
      </RecordTabs>
    </div>
  )
}

/** The title block: name, description, and the two things a reader checks first. */
function FormHeading({ form }: { readonly form: Form }): React.JSX.Element {
  const updateForm = useUpdateForm()
  const patch = (changes: { name?: string; description?: string | null }): void => {
    updateForm.run({ id: form.id, changes })
  }

  return (
    <div className="min-w-0 flex-1">
      <div className="flex flex-wrap items-center gap-2">
        <div className="min-w-0 flex-1">
          <InlineEdit
            value={form.name}
            onChange={(name) => {
              if (name.length > 0) {
                patch({ name })
              }
            }}
            displayClassName="text-[18px] font-semibold tracking-tight text-ink"
          />
        </div>
        <Chip tone={form.status === 'active' ? 'success' : 'neutral'}>{form.status}</Chip>
        {form.createDeal && <Chip tone="accent">Creates deal</Chip>}
      </div>
      <InlineEdit
        value={form.description ?? ''}
        onChange={(description) => {
          patch({ description: description.length === 0 ? null : description })
        }}
        emptyLabel="Add a description…"
        displayClassName="mt-0.5 text-[13px] text-ink-muted"
      />
      {updateForm.error !== null && (
        <div className="mt-2 max-w-md">
          <ErrorPanel error={updateForm.error} />
        </div>
      )}
    </div>
  )
}
