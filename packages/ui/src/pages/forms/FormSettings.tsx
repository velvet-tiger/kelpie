import { FORM_STATUSES } from '@kelpie/schemas'
import type { Form, FormStatus } from '@kelpie/schemas'

import { useUpdateForm } from '../../api/resources/forms.ts'
import { ErrorPanel } from '../../components/QueryState.tsx'
import { SectionHeader } from '../../components/SectionHeader.tsx'

/**
 * The form's identity: status, thank-you copy, and the public key.
 *
 * Every control commits on change, because each one is a single field and the
 * optimistic update in `createResourceHooks` puts the old value back if the
 * PATCH is refused. The field list is the exception and has its own Save; see
 * `FieldsEditor`. What the form *does* on submit — create records, tag them,
 * add to lists, attach the submitter — lives on the Actions tab.
 */

const inputClass =
  'w-full rounded-md border border-border bg-surface-raised px-3 py-2 text-[13px] outline-none focus:border-accent focus:ring-2 focus:ring-accent/20'

export interface FormSettingsProps {
  readonly form: Form
}

export function FormSettings({ form }: FormSettingsProps): React.JSX.Element {
  const updateForm = useUpdateForm()
  const patch = (changes: Parameters<typeof updateForm.run>[0]['changes']): void => {
    updateForm.run({ id: form.id, changes })
  }

  return (
    <div className="max-w-xl space-y-4">
      <SectionHeader title="Settings" description="Status, thank-you copy, and the public key." />

      {updateForm.error !== null && <ErrorPanel error={updateForm.error} />}

      <Labelled label="Status">
        <select
          className={inputClass}
          value={form.status}
          onChange={(event) => {
            patch({ status: event.target.value as FormStatus })
          }}
        >
          {FORM_STATUSES.map((status) => (
            <option key={status} value={status}>
              {status}
            </option>
          ))}
        </select>
        <Hint>A paused form still renders where it is embedded, and says it is closed.</Hint>
      </Labelled>

      <Labelled label="Thank-you message">
        <textarea
          className={`${inputClass} min-h-[72px]`}
          defaultValue={form.thankYouMessage}
          onBlur={(event) => {
            if (event.target.value !== form.thankYouMessage) {
              patch({ thankYouMessage: event.target.value })
            }
          }}
        />
        <Hint>Shown in place of the form once a submission lands.</Hint>
      </Labelled>

      <p className="rounded-md border border-border bg-surface px-3 py-2 text-[12px] text-ink-muted">
        Deal, opportunity, partnership, tags, lists, and attached records live on the{' '}
        <strong className="font-medium text-ink">Actions</strong> tab.
      </p>

      <Labelled label="Public key">
        <input className={`${inputClass} font-mono text-[12px]`} value={form.publicKey} readOnly />
        <Hint>The only credential the public submit takes. It never changes.</Hint>
      </Labelled>
    </div>
  )
}

function Labelled({
  label,
  children,
}: {
  readonly label: string
  readonly children: React.ReactNode
}): React.JSX.Element {
  return (
    <label className="block">
      <span className="mb-1.5 block text-[12px] font-medium text-ink">{label}</span>
      {children}
    </label>
  )
}

function Hint({ children }: { readonly children: React.ReactNode }): React.JSX.Element {
  return <p className="mt-1 text-[11px] text-ink-faint">{children}</p>
}
