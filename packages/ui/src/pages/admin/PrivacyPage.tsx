import { CONSENT_PURPOSE_STATUS_LABELS, CONSENT_PURPOSE_STATUSES } from '@kelpie/schemas'
import type { ConsentPurpose, ConsentPurposeStatus } from '@kelpie/schemas'
import { useMemo, useState } from 'react'
import type { FormEvent } from 'react'

import {
  useConsentPurposes,
  useCreateConsentPurpose,
  useDeleteConsentPurpose,
  useUpdateConsentPurpose,
} from '../../api/resources/consentPurposes.ts'
import { useSession } from '../../api/resources/session.ts'
import { AddButton } from '../../components/SectionHeader.tsx'
import { PageHeader } from '../../components/PageHeader.tsx'
import { ErrorPanel, LoadingPanel } from '../../components/QueryState.tsx'

/**
 * Admin surface for workspace consent purposes.
 *
 * Admin-only, matching Custom fields: a purpose change touches every form,
 * list, and import job that names it, and is team-wide config. A purpose has
 * a default status that every Person without an explicit override inherits.
 */

export function PrivacyPage(): React.JSX.Element {
  const { session } = useSession()
  const isAdmin = session?.role === 'owner' || session?.role === 'admin'

  return (
    <div className="animate-slide-in mx-auto max-w-4xl space-y-6">
      <PageHeader
        title="Privacy"
        description="Consent purposes for the things you contact people about. A form's consent checkbox, a list you add signups to, and an import can each grant one of these — and every Person's record reflects it."
      />
      {isAdmin ? <PurposesAdmin /> : <MemberNotice />}
    </div>
  )
}

function MemberNotice(): React.JSX.Element {
  return (
    <p className="rounded-md border border-border px-4 py-3 text-[13px] text-ink-muted">
      Consent purposes are managed by workspace admins.
    </p>
  )
}

function PurposesAdmin(): React.JSX.Element {
  const [adding, setAdding] = useState(false)
  const [seeding, setSeeding] = useState(false)
  const purposes = useConsentPurposes({ sort: 'sort_order', limit: 200 })
  const create = useCreateConsentPurpose()

  async function seedStarters(): Promise<void> {
    setSeeding(true)
    try {
      await create.runAsync({
        slug: 'contact',
        label: 'Contact',
        description: 'Being contacted by the workspace about our work together.',
        defaultStatus: 'unknown',
      })
      await create.runAsync({
        slug: 'marketing',
        label: 'Marketing',
        description: 'Marketing communications — newsletters, product updates, and campaigns.',
        defaultStatus: 'unknown',
      })
    } catch {
      // Error rendered inline via the ErrorPanel below.
    } finally {
      setSeeding(false)
    }
  }

  return (
    <>
      <div className="flex justify-end">
        <AddButton
          onClick={() => {
            setAdding(true)
          }}
          label="Add a purpose"
        />
      </div>

      {adding && (
        <AddPurposeForm
          onDone={() => {
            setAdding(false)
          }}
        />
      )}

      {purposes.error !== null && <ErrorPanel error={purposes.error} />}
      {create.error !== null && <ErrorPanel error={create.error} />}
      {purposes.isLoading ? (
        <LoadingPanel label="Loading purposes…" />
      ) : purposes.records.length === 0 ? (
        <EmptyState
          onAdd={() => {
            setAdding(true)
          }}
          onSeedStarters={() => {
            void seedStarters()
          }}
          isSeeding={seeding}
        />
      ) : (
        <ul className="space-y-3">
          {purposes.records.map((purpose) => (
            <li key={purpose.id}>
              <PurposeRow purpose={purpose} />
            </li>
          ))}
        </ul>
      )}
    </>
  )
}

interface EmptyStateProps {
  readonly onAdd: () => void
  readonly onSeedStarters: () => void
  readonly isSeeding: boolean
}

function EmptyState({ onAdd, onSeedStarters, isSeeding }: EmptyStateProps): React.JSX.Element {
  return (
    <div className="rounded-md border border-dashed border-border p-6 text-[13px]">
      <p className="font-medium text-ink">You have no consent purposes yet.</p>
      <p className="mt-1 text-ink-muted">
        A purpose is what a person is agreeing to — being contacted at all, marketing, research.
        Every workspace usually has at least a general <span className="font-medium">Contact</span>{' '}
        purpose. Forms, lists, and imports that don&rsquo;t need consent don&rsquo;t need one.
      </p>
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={onSeedStarters}
          disabled={isSeeding}
          className="rounded-md bg-accent px-3 py-1.5 text-[12px] font-medium text-white hover:bg-accent-hover disabled:opacity-50"
        >
          {isSeeding ? 'Adding…' : 'Add Contact & Marketing'}
        </button>
        <button
          type="button"
          onClick={onAdd}
          className="rounded-md border border-border px-3 py-1.5 text-[12px] font-medium text-ink hover:border-ink-muted"
        >
          Add my own
        </button>
      </div>
    </div>
  )
}

interface AddPurposeFormProps {
  readonly onDone: () => void
}

function AddPurposeForm({ onDone }: AddPurposeFormProps): React.JSX.Element {
  const create = useCreateConsentPurpose()
  const [label, setLabel] = useState('')
  const [slug, setSlug] = useState('')
  const [slugEdited, setSlugEdited] = useState(false)
  const [description, setDescription] = useState('')
  const [defaultStatus, setDefaultStatus] = useState<ConsentPurposeStatus>('unknown')

  const derivedSlug = useMemo(
    () => (slugEdited ? slug : slugify(label)),
    [slugEdited, slug, label],
  )

  function submit(event: FormEvent): void {
    event.preventDefault()
    const trimmedLabel = label.trim()
    if (trimmedLabel.length === 0) {
      return
    }
    create
      .runAsync({
        slug: derivedSlug,
        label: trimmedLabel,
        description: description.trim(),
        defaultStatus,
      })
      .then(() => {
        setLabel('')
        setSlug('')
        setSlugEdited(false)
        setDescription('')
        setDefaultStatus('unknown')
        onDone()
      })
      .catch(() => {
        // Error rendered below.
      })
  }

  return (
    <form
      onSubmit={submit}
      className="space-y-3 rounded-md border border-border bg-surface-raised p-4"
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Label">
          <input
            className="w-full rounded-md border border-border bg-transparent px-2 py-1 text-[13px] outline-none focus:border-accent"
            value={label}
            onChange={(event) => {
              setLabel(event.target.value)
            }}
            required
          />
        </Field>
        <Field label="Slug">
          <input
            className="w-full rounded-md border border-border bg-transparent px-2 py-1 font-mono text-[12px] outline-none focus:border-accent"
            value={derivedSlug}
            onChange={(event) => {
              setSlug(event.target.value)
              setSlugEdited(true)
            }}
            placeholder="lowercase_snake_case"
            pattern="^[a-z][a-z0-9_]*$"
            required
          />
        </Field>
        <Field label="Default status">
          <select
            className="w-full rounded-md border border-border bg-transparent px-2 py-1 text-[13px] outline-none focus:border-accent"
            value={defaultStatus}
            onChange={(event) => {
              setDefaultStatus(event.target.value as ConsentPurposeStatus)
            }}
          >
            {CONSENT_PURPOSE_STATUSES.map((option) => (
              <option key={option} value={option}>
                {CONSENT_PURPOSE_STATUS_LABELS[option]}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <Field label="Description (shown on capture surfaces and to agents)">
        <textarea
          className="min-h-[60px] w-full rounded-md border border-border bg-transparent px-2 py-1 text-[13px] outline-none focus:border-accent"
          value={description}
          onChange={(event) => {
            setDescription(event.target.value)
          }}
        />
      </Field>

      {create.error !== null && <ErrorPanel error={create.error} />}

      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={() => {
            onDone()
          }}
          className="rounded-md border border-border px-3 py-1 text-[12px] text-ink-muted hover:text-ink"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={create.isPending}
          className="rounded-md bg-accent px-3 py-1 text-[12px] font-medium text-white hover:bg-accent-hover disabled:opacity-50"
        >
          {create.isPending ? 'Adding…' : 'Add purpose'}
        </button>
      </div>
    </form>
  )
}

interface PurposeRowProps {
  readonly purpose: ConsentPurpose
}

function PurposeRow({ purpose }: PurposeRowProps): React.JSX.Element {
  const update = useUpdateConsentPurpose()
  const remove = useDeleteConsentPurpose()
  const [editing, setEditing] = useState(false)
  const [label, setLabel] = useState(purpose.label)
  const [description, setDescription] = useState(purpose.description)
  const [defaultStatus, setDefaultStatus] = useState<ConsentPurposeStatus>(purpose.defaultStatus)
  const [confirmingDelete, setConfirmingDelete] = useState(false)

  function save(event: FormEvent): void {
    event.preventDefault()
    update
      .runAsync({
        id: purpose.id,
        changes: {
          label: label.trim(),
          description: description.trim(),
          defaultStatus,
        },
      })
      .then(() => {
        setEditing(false)
      })
      .catch(() => {
        // Error rendered inline.
      })
  }

  return (
    <div className="rounded-md border border-border p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-2">
            <div className="text-[14px] font-semibold text-ink">{purpose.label}</div>
            <code className="rounded bg-surface-raised px-1.5 py-0.5 font-mono text-[11px] text-ink-muted">
              {purpose.slug}
            </code>
            <span className="text-[11px] text-ink-muted">
              Default: {CONSENT_PURPOSE_STATUS_LABELS[purpose.defaultStatus]}
            </span>
          </div>
          {purpose.description.length > 0 && (
            <p className="mt-1 text-[12px] text-ink-muted">{purpose.description}</p>
          )}
        </div>
        <div className="flex shrink-0 gap-2">
          <button
            type="button"
            onClick={() => {
              setEditing((current) => !current)
            }}
            className="text-[12px] text-ink-muted hover:text-ink"
          >
            {editing ? 'Cancel' : 'Edit'}
          </button>
          <button
            type="button"
            onClick={() => {
              setConfirmingDelete(true)
            }}
            className="text-[12px] text-red-600 hover:text-red-700"
          >
            Delete
          </button>
        </div>
      </div>

      {editing && (
        <form onSubmit={save} className="mt-3 space-y-2">
          <Field label="Label">
            <input
              className="w-full rounded-md border border-border bg-transparent px-2 py-1 text-[13px] outline-none focus:border-accent"
              value={label}
              onChange={(event) => {
                setLabel(event.target.value)
              }}
              required
            />
          </Field>
          <Field label="Default status">
            <select
              className="w-full rounded-md border border-border bg-transparent px-2 py-1 text-[13px] outline-none focus:border-accent"
              value={defaultStatus}
              onChange={(event) => {
                setDefaultStatus(event.target.value as ConsentPurposeStatus)
              }}
            >
              {CONSENT_PURPOSE_STATUSES.map((option) => (
                <option key={option} value={option}>
                  {CONSENT_PURPOSE_STATUS_LABELS[option]}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Description">
            <textarea
              className="min-h-[60px] w-full rounded-md border border-border bg-transparent px-2 py-1 text-[13px] outline-none focus:border-accent"
              value={description}
              onChange={(event) => {
                setDescription(event.target.value)
              }}
            />
          </Field>
          {update.error !== null && <ErrorPanel error={update.error} />}
          <div className="flex justify-end">
            <button
              type="submit"
              disabled={update.isPending}
              className="rounded-md bg-accent px-3 py-1 text-[12px] font-medium text-white hover:bg-accent-hover disabled:opacity-50"
            >
              {update.isPending ? 'Saving…' : 'Save'}
            </button>
          </div>
        </form>
      )}

      {confirmingDelete && (
        <div className="mt-3 rounded-md border border-red-300 bg-red-50 p-3 text-[13px] text-red-800 dark:border-red-800 dark:bg-red-950/40 dark:text-red-200">
          <p>
            Delete the {purpose.label} purpose? Remove it from every form field and list that
            names it first — the delete refuses otherwise.
          </p>
          {remove.error !== null && <ErrorPanel error={remove.error} />}
          <div className="mt-2 flex justify-end gap-2">
            <button
              type="button"
              onClick={() => {
                setConfirmingDelete(false)
              }}
              className="rounded-md border border-red-300 px-3 py-1 text-[12px] hover:bg-red-100 dark:border-red-800 dark:hover:bg-red-900/40"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => {
                remove
                  .runAsync(purpose.id)
                  .then(() => {
                    setConfirmingDelete(false)
                  })
                  .catch(() => {
                    // Error rendered inline.
                  })
              }}
              disabled={remove.isPending}
              className="rounded-md bg-red-600 px-3 py-1 text-[12px] font-medium text-white hover:bg-red-700 disabled:opacity-50"
            >
              {remove.isPending ? 'Deleting…' : 'Delete'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

interface FieldProps {
  readonly label: string
  readonly children: React.ReactNode
}

function Field({ label, children }: FieldProps): React.JSX.Element {
  return (
    <label className="block text-[12px]">
      <span className="mb-1 block font-medium text-ink-muted">{label}</span>
      {children}
    </label>
  )
}

function slugify(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '_')
    .replace(/^_+|_+$/gu, '')
    .replace(/^([0-9])/u, '_$1')
}
