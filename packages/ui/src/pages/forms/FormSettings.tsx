import { FORM_STATUSES } from '@kelpie/schemas'
import type { Form, FormStatus } from '@kelpie/schemas'

import { usePipelineStages } from '../../api/resources/pipelineStages.ts'
import { useUpdateForm } from '../../api/resources/forms.ts'
import { ErrorPanel } from '../../components/QueryState.tsx'
import { SectionHeader } from '../../components/SectionHeader.tsx'

/**
 * What the form does with a submission.
 *
 * Every control commits on change, because each one is a single field and the
 * optimistic update in `createResourceHooks` puts the old value back if the
 * PATCH is refused. The field list is the exception and has its own Save; see
 * `FieldsEditor`.
 */

const inputClass =
  'w-full rounded-md border border-border bg-surface-raised px-3 py-2 text-[13px] outline-none focus:border-accent focus:ring-2 focus:ring-accent/20'

export interface FormSettingsProps {
  readonly form: Form
}

export function FormSettings({ form }: FormSettingsProps): React.JSX.Element {
  const updateForm = useUpdateForm()
  const stages = usePipelineStages('deal')
  const patch = (changes: Parameters<typeof updateForm.run>[0]['changes']): void => {
    updateForm.run({ id: form.id, changes })
  }

  /** The server refuses `create_deal` without a company mapping, so say so before it does. */
  const hasCompanyField = form.fields.some((field) => field.mapTo.startsWith('company.'))

  return (
    <div className="max-w-xl space-y-4">
      <SectionHeader title="Settings" description="Status, thank-you copy, and deal creation." />

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

      <div className="space-y-3 rounded-md border border-border p-4">
        <label className="flex items-center gap-2 text-[13px] font-medium text-ink">
          <input
            type="checkbox"
            checked={form.createDeal}
            disabled={!hasCompanyField && !form.createDeal}
            onChange={(event) => {
              patch({ createDeal: event.target.checked })
            }}
          />
          Create a Deal on submit
        </label>

        {!hasCompanyField && (
          <p className="text-[12px] text-danger">
            Add a field mapped to Company · name or Company · domain first. A deal belongs to a
            company, and this form collects neither.
          </p>
        )}

        {form.createDeal && (
          <>
            <Labelled label="Deal stage">
              <select
                className={inputClass}
                value={form.dealStageId ?? ''}
                onChange={(event) => {
                  patch({ dealStageId: event.target.value.length === 0 ? null : event.target.value })
                }}
              >
                <option value="">First open stage</option>
                {stages.records.map((stage) => (
                  <option key={stage.id} value={stage.id}>
                    {stage.label}
                  </option>
                ))}
              </select>
              <Hint>
                Leaving this on the first open stage follows the board, so reordering it does not
                strand old forms on a column that moved.
              </Hint>
            </Labelled>

            <Labelled label="Deal name template">
              <input
                className={inputClass}
                defaultValue={form.dealNameTemplate ?? ''}
                onBlur={(event) => {
                  const next = event.target.value.length === 0 ? null : event.target.value

                  if (next !== form.dealNameTemplate) {
                    patch({ dealNameTemplate: next })
                  }
                }}
              />
              <Hint>
                {'Tokens: {{company.name}} and {{person.name}}. A field mapped to Deal · name wins over this.'}
              </Hint>
            </Labelled>
          </>
        )}
      </div>

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
