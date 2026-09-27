import { useState } from 'react'
import { FORM_SLUG_PATTERN, FORM_STATUSES } from '@kelpie/schemas'
import type { Form, FormStatus } from '@kelpie/schemas'

import { ApiError } from '../../api/client.ts'
import {
  useRegenerateFormSlug,
  useUpdateForm,
  useUpdateFormSlug,
} from '../../api/resources/forms.ts'
import { ErrorPanel } from '../../components/QueryState.tsx'
import { SectionHeader } from '../../components/SectionHeader.tsx'

/**
 * The form's identity: status, public heading, thank-you copy, and the slug.
 *
 * Every control commits on change, because each one is a single field and the
 * optimistic update in `createResourceHooks` puts the old value back if the
 * PATCH is refused. The field list is the exception and has its own Save; see
 * `FieldsEditor`, and so is the slug, which asks first; see `SlugSetting`. What the form *does* on submit — create records, tag them,
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
      <SectionHeader
        title="Settings"
        description="Status, the public form title, thank-you copy, and the slug in its submit URL."
      />

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

      <Labelled label="Form title">
        <input
          className={inputClass}
          defaultValue={form.title}
          onBlur={(event) => {
            const next = event.target.value.trim()
            if (next.length > 0 && next !== form.title) {
              patch({ title: next })
            } else if (next.length === 0) {
              event.target.value = form.title
            }
          }}
        />
        <Hint>
          Shown as the heading on the hosted and embedded form. Defaults to the form name.
        </Hint>
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

      {/* Keyed on the slug so the draft starts over whenever the stored slug moves. */}
      <SlugSetting key={form.slug} form={form} />
    </div>
  )
}

type SlugAction = 'change' | 'regenerate'

/**
 * The form's slug, with an edit and a Regenerate button.
 *
 * The slug is only in the submit URL. Embed snippets use the form id, and the
 * embed page carries the current submit URL, so embeds follow a change on their
 * own. Anything that saved the old submit URL does not, which is the point of
 * Regenerate. So, unlike the other settings, a change here does not commit on
 * blur: both actions say what moves and wait for a confirm.
 */
function SlugSetting({ form }: { readonly form: Form }): React.JSX.Element {
  const updateSlug = useUpdateFormSlug()
  const regenerateSlug = useRegenerateFormSlug()
  const [draft, setDraft] = useState(form.slug)
  const [confirming, setConfirming] = useState<SlugAction | null>(null)
  const [lastError, setLastError] = useState<Error | null>(null)

  const trimmed = draft.trim()
  const edited = trimmed !== form.slug
  const valid = FORM_SLUG_PATTERN.test(trimmed)
  const isPending = updateSlug.isPending || regenerateSlug.isPending
  const pendingAction: SlugAction | null = edited ? 'change' : confirming

  const reset = (): void => {
    setDraft(form.slug)
    setConfirming(null)
    setLastError(null)
  }

  const commit = async (): Promise<void> => {
    setLastError(null)
    try {
      // Success moves `form.slug`, and the key on this component then resets it.
      await (pendingAction === 'regenerate'
        ? regenerateSlug.runAsync(form.id)
        : updateSlug.runAsync({ id: form.id, slug: trimmed }))
    } catch (error) {
      setLastError(error instanceof Error ? error : new Error(String(error)))
    }
  }

  return (
    <div>
      <label htmlFor="form-slug" className="mb-1.5 block text-[12px] font-medium text-ink">
        Slug
      </label>
      <div className="flex gap-2">
        <input
          id="form-slug"
          className={`${inputClass} font-mono text-[12px]`}
          value={draft}
          spellCheck={false}
          autoComplete="off"
          disabled={isPending}
          aria-invalid={edited && !valid}
          onChange={(event) => {
            setDraft(event.target.value)
            setConfirming(null)
            setLastError(null)
          }}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              reset()
            }
          }}
        />
        <button
          type="button"
          disabled={isPending || edited}
          onClick={() => {
            setConfirming('regenerate')
            setLastError(null)
          }}
          className="shrink-0 rounded-md border border-border bg-surface-raised px-3 py-2 text-[12px] font-medium text-ink transition hover:bg-surface disabled:opacity-50"
        >
          Regenerate
        </button>
      </div>

      {edited && !valid ? (
        <p className="mt-1 text-[11px] text-danger">
          Use 3 to 64 characters: letters, digits, hyphens (-) or underscores (_).
        </p>
      ) : (
        <Hint>
          The name of this form in its submit URL. It is not a secret: every page that embeds
          the form shows it. If a bot sends spam to the form, regenerate the slug. Your
          embeds keep working and use the new slug.
        </Hint>
      )}

      {pendingAction !== null && (edited ? valid : true) && (
        <div className="mt-2 rounded-md border border-border bg-surface px-3 py-2">
          <p className="text-[12px] text-ink">
            {pendingAction === 'regenerate'
              ? 'Replace the slug with a new random one?'
              : `Change the slug to "${trimmed}"?`}{' '}
            Embeds on your sites change to the new slug in less than a minute. You do not
            need to paste new code. Anything that sends to the old submit URL directly gets
            an error.
          </p>
          <div className="mt-2 flex justify-end gap-2">
            <button
              type="button"
              disabled={isPending}
              onClick={reset}
              className="rounded-md px-2 py-1 text-[12px] font-medium text-ink-muted hover:text-ink"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={isPending}
              onClick={() => {
                void commit()
              }}
              className="rounded-md bg-accent px-2.5 py-1 text-[12px] font-semibold text-accent-fg transition hover:bg-accent-hover disabled:opacity-50"
            >
              {isPending
                ? 'Saving…'
                : pendingAction === 'regenerate'
                  ? 'Regenerate slug'
                  : 'Change slug'}
            </button>
          </div>
        </div>
      )}

      {lastError !== null && <p className="mt-1 text-[11px] text-danger">{slugErrorText(lastError)}</p>}
    </div>
  )
}

/** The field-level message for a refused slug write, when the API gives one. */
function slugErrorText(error: Error): string {
  if (error instanceof ApiError && error.status === 409) {
    return 'Another form in this workspace uses this slug. Choose a different one.'
  }

  return error.message
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
