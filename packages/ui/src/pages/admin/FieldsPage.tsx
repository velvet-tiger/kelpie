import {
  CUSTOM_FIELD_OBJECT_TYPE_LABELS,
  CUSTOM_FIELD_OBJECT_TYPES,
  CUSTOM_FIELD_TYPE_LABELS,
  CUSTOM_FIELD_TYPES,
  CUSTOM_FIELD_TYPES_WITH_OPTIONS,
} from '@kelpie/schemas'
import type {
  CustomFieldDefinition,
  CustomFieldObjectType,
  CustomFieldType,
} from '@kelpie/schemas'
import { useMemo, useState } from 'react'
import type { FormEvent } from 'react'

import {
  useCreateCustomField,
  useCustomFields,
  useDeleteCustomField,
  useUpdateCustomField,
} from '../../api/resources/customFields.ts'
import { useSession } from '../../api/resources/session.ts'
import { AddButton } from '../../components/SectionHeader.tsx'
import { PageHeader } from '../../components/PageHeader.tsx'
import { ErrorPanel, LoadingPanel } from '../../components/QueryState.tsx'
import { SegmentedControl } from '../../components/SegmentedControl.tsx'

/**
 * Admin surface for workspace-defined fields.
 *
 * Admin-only, matching the pattern from `WebhooksPage` — a definition changes
 * the shape of every record of one object type and is team-wide config, not a
 * per-user preference.
 *
 * Reorder in v1 is server-side via `PATCH sort_order`; a drag-and-drop UI is
 * the next tweak and does not change the wire.
 */

const OBJECT_TYPE_OPTIONS: readonly { id: CustomFieldObjectType; label: string }[] =
  CUSTOM_FIELD_OBJECT_TYPES.map((id) => ({
    id,
    label: CUSTOM_FIELD_OBJECT_TYPE_LABELS[id],
  }))

const OPTIONS_TYPES: ReadonlySet<CustomFieldType> = new Set(CUSTOM_FIELD_TYPES_WITH_OPTIONS)

export function FieldsPage(): React.JSX.Element {
  const { session } = useSession()
  const isAdmin = session?.role === 'owner' || session?.role === 'admin'

  return (
    <div className="animate-slide-in mx-auto max-w-4xl space-y-6">
      <PageHeader
        title="Custom fields"
        description="Add workspace-defined fields to the six main record types. Values on records go through the same API the UI uses."
      />
      {isAdmin ? <FieldsAdmin /> : <MemberNotice />}
    </div>
  )
}

function MemberNotice(): React.JSX.Element {
  return (
    <p className="rounded-md border border-border px-4 py-3 text-[13px] text-ink-muted">
      Custom fields are managed by workspace admins.
    </p>
  )
}

function FieldsAdmin(): React.JSX.Element {
  const [objectType, setObjectType] = useState<CustomFieldObjectType>('deal')
  const [adding, setAdding] = useState(false)
  const definitions = useCustomFields({ objectType, sort: 'sort_order', limit: 200 })

  return (
    <>
      <div className="flex flex-wrap items-center gap-3">
        <SegmentedControl
          value={objectType}
          onChange={setObjectType}
          options={OBJECT_TYPE_OPTIONS}
          ariaLabel="Record type"
        />
        <div className="ml-auto">
          <AddButton
            onClick={() => {
              setAdding(true)
            }}
            label="New field"
          />
        </div>
      </div>

      {adding && (
        <AddFieldForm
          objectType={objectType}
          onDone={() => {
            setAdding(false)
          }}
        />
      )}

      {definitions.error !== null && <ErrorPanel error={definitions.error} />}
      {definitions.isLoading ? (
        <LoadingPanel label="Loading fields…" />
      ) : definitions.records.length === 0 ? (
        <p className="text-[13px] text-ink-muted">
          No custom fields on {CUSTOM_FIELD_OBJECT_TYPE_LABELS[objectType].toLowerCase()} records yet.
        </p>
      ) : (
        <ul className="space-y-3">
          {definitions.records.map((definition) => (
            <li key={definition.id}>
              <FieldRow definition={definition} />
            </li>
          ))}
        </ul>
      )}
    </>
  )
}

interface AddFieldFormProps {
  readonly objectType: CustomFieldObjectType
  readonly onDone: () => void
}

function AddFieldForm({ objectType, onDone }: AddFieldFormProps): React.JSX.Element {
  const create = useCreateCustomField()
  const [label, setLabel] = useState('')
  const [key, setKey] = useState('')
  const [keyEdited, setKeyEdited] = useState(false)
  const [type, setType] = useState<CustomFieldType>('text')
  const [optionsText, setOptionsText] = useState('')
  const [description, setDescription] = useState('')

  const derivedKey = useMemo(() => (keyEdited ? key : slugify(label)), [keyEdited, key, label])

  function submit(event: FormEvent): void {
    event.preventDefault()
    const trimmedLabel = label.trim()
    if (trimmedLabel.length === 0) {
      return
    }
    const options = OPTIONS_TYPES.has(type)
      ? optionsText
          .split(/[\n,]/u)
          .map((option) => option.trim())
          .filter((option) => option.length > 0)
      : []
    create.runAsync({
      objectType,
      key: derivedKey,
      label: trimmedLabel,
      type,
      options,
      description: description.trim(),
    })
      .then(() => {
        setLabel('')
        setKey('')
        setKeyEdited(false)
        setType('text')
        setOptionsText('')
        setDescription('')
        onDone()
      })
      .catch(() => {
        // The mutation error is rendered below the form; keep the values.
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
        <Field label="Key">
          <input
            className="w-full rounded-md border border-border bg-transparent px-2 py-1 font-mono text-[12px] outline-none focus:border-accent"
            value={derivedKey}
            onChange={(event) => {
              setKey(event.target.value)
              setKeyEdited(true)
            }}
            placeholder="lowercase_snake_case"
            pattern="^[a-z][a-z0-9_]*$"
            required
          />
        </Field>
        <Field label="Type">
          <select
            className="w-full rounded-md border border-border bg-transparent px-2 py-1 text-[13px] outline-none focus:border-accent"
            value={type}
            onChange={(event) => {
              setType(event.target.value as CustomFieldType)
            }}
          >
            {CUSTOM_FIELD_TYPES.map((option) => (
              <option key={option} value={option}>
                {CUSTOM_FIELD_TYPE_LABELS[option]}
              </option>
            ))}
          </select>
        </Field>
        {OPTIONS_TYPES.has(type) && (
          <Field label="Options (one per line, or comma-separated)">
            <textarea
              className="min-h-[80px] w-full rounded-md border border-border bg-transparent px-2 py-1 text-[13px] outline-none focus:border-accent"
              value={optionsText}
              onChange={(event) => {
                setOptionsText(event.target.value)
              }}
              required
            />
          </Field>
        )}
      </div>
      <Field label="Description (agent-facing help text)">
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
          {create.isPending ? 'Adding…' : 'Add field'}
        </button>
      </div>
    </form>
  )
}

interface FieldRowProps {
  readonly definition: CustomFieldDefinition
}

function FieldRow({ definition }: FieldRowProps): React.JSX.Element {
  const update = useUpdateCustomField()
  const remove = useDeleteCustomField()
  const [editing, setEditing] = useState(false)
  const [label, setLabel] = useState(definition.label)
  const [description, setDescription] = useState(definition.description)
  const [optionsText, setOptionsText] = useState(definition.options.join('\n'))
  const [confirmingDelete, setConfirmingDelete] = useState(false)

  const hasOptions = OPTIONS_TYPES.has(definition.type as CustomFieldType)

  function save(event: FormEvent): void {
    event.preventDefault()
    const options = hasOptions
      ? optionsText
          .split(/[\n,]/u)
          .map((option) => option.trim())
          .filter((option) => option.length > 0)
      : undefined
    update.runAsync({
      id: definition.id,
      changes: {
        label: label.trim(),
        description: description.trim(),
        ...(options === undefined ? {} : { options }),
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
            <div className="text-[14px] font-semibold text-ink">{definition.label}</div>
            <code className="rounded bg-surface-raised px-1.5 py-0.5 font-mono text-[11px] text-ink-muted">
              {definition.key}
            </code>
            <span className="text-[11px] text-ink-muted">
              {CUSTOM_FIELD_TYPE_LABELS[definition.type as CustomFieldType]}
            </span>
          </div>
          {definition.description.length > 0 && (
            <p className="mt-1 text-[12px] text-ink-muted">{definition.description}</p>
          )}
          {hasOptions && (
            <p className="mt-1 text-[12px] text-ink-muted">
              Options: {definition.options.join(', ')}
            </p>
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
          {hasOptions && (
            <Field label="Options">
              <textarea
                className="min-h-[80px] w-full rounded-md border border-border bg-transparent px-2 py-1 text-[13px] outline-none focus:border-accent"
                value={optionsText}
                onChange={(event) => {
                  setOptionsText(event.target.value)
                }}
              />
            </Field>
          )}
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
            Delete the {definition.label} field? This removes its stored values from every{' '}
            {CUSTOM_FIELD_OBJECT_TYPE_LABELS[
              definition.objectType as CustomFieldObjectType
            ].toLowerCase()}{' '}
            record.
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
                remove.runAsync(definition.id)
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
