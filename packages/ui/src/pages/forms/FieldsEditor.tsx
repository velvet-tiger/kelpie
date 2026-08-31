import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
} from '@dnd-kit/core'
import type { DragEndEvent } from '@dnd-kit/core'
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { FORM_OPTION_VALUE_TYPES } from '@kelpie/schemas'
import type {
  Form,
  FormFieldInput,
  FormFieldOptionInput,
  FormFieldType,
} from '@kelpie/schemas'
import { useEffect, useMemo, useRef, useState } from 'react'

import { useConsentPurposes } from '../../api/resources/consentPurposes.ts'
import { useCustomFields } from '../../api/resources/customFields.ts'
import type { ConsentPurpose } from '@kelpie/schemas'
import { useUpdateFormFields } from '../../api/resources/forms.ts'
import { ErrorPanel } from '../../components/QueryState.tsx'
import { AddFieldMenu } from './AddFieldMenu.tsx'
import { MapTargetSearch } from './MapTargetSearch.tsx'
import {
  FIELD_TYPE_OPTIONS,
  editField,
  fieldsChanged,
  findProblems,
  insertField,
  isUsable,
  removeField,
  reorderFields,
  toEditableFields,
  toFieldInputs,
  typeForTarget,
} from './fieldList.ts'
import type { EditableField } from './fieldList.ts'

/**
 * The field builder: the form as a visitor will see it, edited in place.
 *
 * The left column renders the fields the way the embed does — labels, required
 * markers, placeholders, the Submit button. Clicking a field selects it and the
 * panel beside the preview edits its settings; the anchor that appears on hover
 * drags it up and down; "Add field" offers ready-made fields to append.
 *
 * Explicitly saved rather than saved per keystroke, unlike the inline editing
 * everywhere else in the app. A write replaces the whole list, so an
 * auto-committing builder would send one full rewrite per character typed into a
 * label, and every one of them would reissue every field id. The draft lives
 * here until somebody presses Save.
 *
 * A field id is a stored id for a saved field and a local one for a field just
 * added; neither is sent. The server assigns ids and positions from the array's
 * order on every write.
 */

let localFieldCount = 0

function localFieldId(): string {
  localFieldCount += 1

  return `new-${String(localFieldCount)}`
}

const inputClass =
  'w-full rounded-md border border-border bg-surface-raised px-2.5 py-1.5 text-[13px] outline-none focus:border-accent focus:ring-2 focus:ring-accent/20'

export interface FieldsEditorProps {
  readonly form: Form
}

export function FieldsEditor({ form }: FieldsEditorProps): React.JSX.Element {
  const [fields, setFields] = useState<EditableField[]>(() => toEditableFields(form))
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const updateFields = useUpdateFormFields()
  const customFields = useCustomFields()
  const customFieldDefinitions = useMemo(
    () =>
      customFields.records.map((definition) => ({
        objectType: definition.objectType,
        key: definition.key,
        label: definition.label,
        type: definition.type,
      })),
    [customFields.records],
  )
  const fieldsRef = useRef<readonly EditableField[]>(fields)
  fieldsRef.current = fields
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor),
  )

  // A save answers with the stored list, ids and all. Re-reading it here is what
  // turns the local ids of newly added fields into the real ones. The selection
  // survives by position: a just-added field comes back at the same index under
  // the id the server gave it.
  useEffect(() => {
    const next = toEditableFields(form)

    setSelectedId((current) => {
      if (current === null || next.some((field) => field.id === current)) {
        return current
      }

      const index = fieldsRef.current.findIndex((field) => field.id === current)

      return index >= 0 ? (next[index]?.id ?? null) : null
    })
    setFields(next)
  }, [form])

  const problems = findProblems(fields, form.createDeal, { customFieldDefinitions })
  const changed = fieldsChanged(form, fields)
  const selected = fields.find((field) => field.id === selectedId)

  function onDragEnd(event: DragEndEvent): void {
    const overId = event.over?.id

    if (overId !== undefined) {
      setFields((current) => reorderFields(current, String(event.active.id), String(overId)))
    }
  }

  function addField(input: FormFieldInput): void {
    const added: EditableField = { ...input, id: localFieldId() }

    setFields((current) => insertField(current, added, selectedId))
    setSelectedId(added.id)
  }

  function save(): void {
    updateFields.run({ id: form.id, fields: toFieldInputs(fields) })
  }

  return (
    <div>
      <div className="mb-3 flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 className="text-[13px] font-semibold text-ink">Fields</h2>
          <p className="mt-0.5 text-[11px] text-ink-faint">
            Click a field to edit it. Drag the anchor to reorder. What a field maps to decides what
            a submission writes.
          </p>
        </div>
        <AddFieldMenu fields={fields} onAdd={addField} />
      </div>

      {problems.list.map((problem) => (
        <p key={problem} className="mb-2 text-[12px] text-danger">
          {problem}
        </p>
      ))}

      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_300px]">
        <div className="rounded-lg border border-border bg-surface-raised p-4 sm:p-6">
          {fields.length === 0 ? (
            <p className="rounded-md border border-dashed border-border px-6 py-10 text-center text-[13px] text-ink-muted">
              No fields yet. A form needs at least an email field.
            </p>
          ) : (
            <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
              <SortableContext
                items={fields.map((field) => field.id)}
                strategy={verticalListSortingStrategy}
              >
                <ul className="flex flex-col gap-1">
                  {fields.map((field) => (
                    <PreviewField
                      key={field.id}
                      field={field}
                      selected={field.id === selectedId}
                      problem={problems.byField.get(field.id)}
                      onSelect={() => {
                        setSelectedId(field.id)
                      }}
                    />
                  ))}
                </ul>
              </SortableContext>
            </DndContext>
          )}

          <div className="mt-4 pl-7" aria-hidden="true">
            <span className="pointer-events-none inline-flex rounded-md bg-accent px-4 py-2 text-[13px] font-semibold text-accent-fg">
              Submit
            </span>
          </div>
        </div>

        {selected === undefined ? (
          <aside className="rounded-lg border border-dashed border-border p-4 text-[13px] text-ink-muted lg:sticky lg:top-4">
            Select a field in the preview to edit its label, mapping, and type. "Add field" appends
            a new one.
          </aside>
        ) : (
          <FieldSettings
            field={selected}
            fields={fields}
            customFieldDefinitions={customFieldDefinitions}
            problem={problems.byField.get(selected.id)}
            onChange={(change) => {
              setFields((current) => editField(current, selected.id, change))
            }}
            onRemove={() => {
              setFields((current) => removeField(current, selected.id))
              setSelectedId(null)
            }}
            onClose={() => {
              setSelectedId(null)
            }}
          />
        )}
      </div>

      {updateFields.error !== null && (
        <div className="mt-3">
          <ErrorPanel error={updateFields.error} />
        </div>
      )}

      <div className="mt-4 flex items-center gap-3">
        <button
          type="button"
          onClick={save}
          disabled={!changed || !isUsable(problems) || updateFields.isPending}
          className="rounded-md bg-accent px-3 py-1.5 text-[12px] font-semibold text-accent-fg transition hover:bg-accent-hover disabled:opacity-50"
        >
          {updateFields.isPending ? 'Saving…' : 'Save fields'}
        </button>
        {changed && (
          <button
            type="button"
            onClick={() => {
              setFields(toEditableFields(form))
              setSelectedId(null)
            }}
            className="text-[12px] font-medium text-ink-muted transition hover:text-ink"
          >
            Discard changes
          </button>
        )}
        {!changed && <span className="text-[12px] text-ink-faint">Saved</span>}
      </div>
    </div>
  )
}

interface PreviewFieldProps {
  readonly field: EditableField
  readonly selected: boolean
  readonly problem: string | undefined
  readonly onSelect: () => void
}

/**
 * One field, rendered the way the embed renders it and inert: the control never
 * takes input here. A full-row button on top is what selects the field, so the
 * click target is the whole thing a visitor would see, and the drag anchor
 * beside the row is the one place a press means "move" instead of "edit".
 */
function PreviewField({ field, selected, problem, onSelect }: PreviewFieldProps): React.JSX.Element {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: field.id,
  })

  return (
    <li
      ref={setNodeRef}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.35 : 1,
      }}
      className="group flex items-start gap-0.5"
    >
      <button
        type="button"
        className="mt-8 shrink-0 cursor-grab touch-none rounded-md px-1 py-1 text-[10px] leading-none text-ink-faint opacity-0 transition hover:text-ink focus-visible:opacity-100 active:cursor-grabbing group-hover:opacity-100"
        aria-label={`Drag ${field.label} to reorder`}
        {...attributes}
        {...listeners}
      >
        ⋮⋮
      </button>

      <div
        className={[
          'relative min-w-0 flex-1 rounded-md p-2.5 transition',
          selected
            ? 'ring-2 ring-accent'
            : problem === undefined
              ? 'ring-1 ring-transparent group-hover:ring-border-strong'
              : 'ring-1 ring-danger/50',
        ].join(' ')}
      >
        <button
          type="button"
          onClick={onSelect}
          aria-label={`Edit ${field.label}`}
          aria-pressed={selected}
          className="absolute inset-0 z-10 cursor-pointer rounded-md"
        />

        <div className="pointer-events-none">
          <span className="mb-1 block text-[13px] font-medium text-ink">
            {field.label}
            {(field.required ?? false) && <span className="ml-0.5 text-danger">*</span>}
          </span>
          <PreviewControl field={field} />
          {problem !== undefined && <p className="mt-1.5 text-[12px] text-danger">{problem}</p>}
        </div>
      </div>
    </li>
  )
}

/** The control itself, matching what the embed serves for each field type. */
function PreviewControl({ field }: { readonly field: EditableField }): React.JSX.Element {
  const controlClass =
    'w-full rounded-md border border-border bg-surface px-3 py-2 text-[13px] text-ink placeholder:text-ink-faint'

  if (field.type === 'textarea') {
    return (
      <textarea
        readOnly
        tabIndex={-1}
        rows={3}
        placeholder={field.placeholder ?? undefined}
        className={controlClass}
      />
    )
  }

  if (field.type === 'select') {
    const options = field.options ?? []

    // Remounted whenever the choices change, so the uncontrolled select cannot
    // show a choice that no longer exists. The embed gives a non-required
    // select a blank "—" first, and the preview shows the same.
    return (
      <select
        key={options.map((option) => option.key).join('\n')}
        tabIndex={-1}
        defaultValue=""
        className={controlClass}
      >
        {(field.required ?? false) === false && <option value="">—</option>}
        {options.map((option) => (
          <option key={option.key} value={option.key}>
            {option.value}
          </option>
        ))}
      </select>
    )
  }

  if (field.type === 'consent') {
    return <ConsentPreview field={field} />
  }

  if (field.type === 'notice') {
    return <NoticePreview field={field} />
  }

  return (
    <input
      readOnly
      tabIndex={-1}
      type={field.type === 'email' ? 'email' : 'text'}
      placeholder={field.placeholder ?? undefined}
      className={controlClass}
    />
  )
}

/**
 * The consent preview — matches what the visitor sees: a statement above,
 * one checkbox per selected purpose below, each labelled by the purpose. The
 * label above (in FieldRow) still shows the field heading.
 */
/**
 * The notice preview — prose only, styled like the hosted embed. There is no
 * checkbox because a notice is granted implicitly by submission.
 */
function NoticePreview({ field }: { readonly field: EditableField }): React.JSX.Element {
  const statement = (field.statement ?? '').trim()
  return (
    <div>
      {statement.length === 0 ? (
        <p className="text-[11px] italic text-ink-faint">
          Add a statement in the settings panel — the notice text the visitor reads.
        </p>
      ) : (
        <p className="rounded-md border border-border bg-surface px-3 py-2 text-[12px] leading-snug text-ink-muted whitespace-pre-line">
          {statement}
        </p>
      )}
    </div>
  )
}

function ConsentPreview({ field }: { readonly field: EditableField }): React.JSX.Element {
  const purposes = useConsentPurposes({ sort: 'sort_order', limit: 200 })
  const labelById = new Map<string, string>(
    purposes.records.map((purpose: ConsentPurpose) => [purpose.id, purpose.label]),
  )
  const statement = field.statement ?? field.label
  const ids = field.consentPurposeIds ?? []
  const overrides = field.consentPurposeLabels ?? {}

  return (
    <div className="space-y-1.5">
      <p className="text-[12px] text-ink-muted">{statement}</p>
      {ids.length === 0 ? (
        <p className="text-[11px] italic text-ink-faint">
          Pick at least one purpose in the settings panel.
        </p>
      ) : (
        ids.map((id) => (
          <div key={id} className="flex items-start gap-2">
            <input readOnly tabIndex={-1} type="checkbox" className="mt-0.5" />
            <span className="text-[13px] text-ink">
              {overrides[id] ?? labelById.get(id) ?? id}
            </span>
          </div>
        ))
      )}
    </div>
  )
}

interface FieldSettingsProps {
  readonly field: EditableField
  readonly fields: readonly EditableField[]
  readonly customFieldDefinitions: readonly {
    readonly objectType: import('@kelpie/schemas').CustomFieldObjectType
    readonly key: string
    readonly label: string
    readonly type: import('@kelpie/schemas').CustomFieldType
  }[]
  readonly problem: string | undefined
  readonly onChange: (change: Partial<FormFieldInput>) => void
  readonly onRemove: () => void
  readonly onClose: () => void
}

/** The panel a selected field's settings edit in. */
function FieldSettings({
  field,
  fields,
  customFieldDefinitions,
  problem,
  onChange,
  onRemove,
  onClose,
}: FieldSettingsProps): React.JSX.Element {
  const usedTargets = useMemo(
    () =>
      new Set(
        fields.filter((entry) => entry.id !== field.id).map((entry) => entry.mapTo),
      ),
    [fields, field.id],
  )

  return (
    <aside className="rounded-lg border border-border bg-surface-raised p-4 lg:sticky lg:top-4">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h3 className="text-[12px] font-semibold text-ink">Field settings</h3>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close field settings"
          className="rounded-md px-1.5 py-1 text-[12px] text-ink-faint transition hover:text-ink"
        >
          ✕
        </button>
      </div>

      <div className="flex flex-col gap-3">
        <label className="block">
          <span className="mb-1 block text-[11px] font-medium text-ink-faint">Label</span>
          <input
            className={inputClass}
            value={field.label}
            onChange={(event) => {
              onChange({ label: event.target.value })
            }}
          />
        </label>

        <div className="block">
          <span className="mb-1 block text-[11px] font-medium text-ink-faint">Maps to</span>
          <MapTargetSearch
            value={field.mapTo}
            usedTargets={usedTargets}
            onChange={(mapTo) => {
              onChange({
                mapTo,
                type: typeForTarget(mapTo, field.type, customFieldDefinitions),
              })
            }}
          />
        </div>

        <label className="block">
          <span className="mb-1 block text-[11px] font-medium text-ink-faint">Type</span>
          <select
            className={inputClass}
            value={field.type}
            onChange={(event) => {
              onChange({ type: event.target.value as FormFieldType })
            }}
          >
            {FIELD_TYPE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>

        <label className="block">
          <span className="mb-1 block text-[11px] font-medium text-ink-faint">Placeholder</span>
          <input
            className={inputClass}
            value={field.placeholder ?? ''}
            onChange={(event) => {
              onChange({ placeholder: event.target.value.length === 0 ? null : event.target.value })
            }}
          />
        </label>

        <label className="flex items-center gap-2 text-[12px] text-ink-muted">
          <input
            type="checkbox"
            checked={field.required ?? false}
            onChange={(event) => {
              onChange({ required: event.target.checked })
            }}
          />
          Required
        </label>

        {field.type === 'select' && (
          <OptionsEditor
            options={field.options ?? []}
            onChange={(options) => {
              onChange({ options })
            }}
          />
        )}

        {(field.type === 'consent' || field.type === 'notice') && (
          <>
            <label className="block">
              <span className="mb-1 block text-[11px] font-medium text-ink-faint">
                {field.type === 'notice'
                  ? 'Notice (the text the visitor reads)'
                  : 'Statement (intro sentence above the checkboxes)'}
              </span>
              <textarea
                className={inputClass}
                rows={field.type === 'notice' ? 5 : 3}
                value={field.statement ?? ''}
                onChange={(event) => {
                  const value = event.target.value
                  onChange({ statement: value.length === 0 ? null : value })
                }}
                placeholder={
                  field.type === 'notice'
                    ? 'By submitting this form you agree to us storing your information and using it to contact you about your enquiry.'
                    : 'Please tell us how we can contact you.'
                }
              />
            </label>
            <ConsentPurposePicker
              mode={field.type === 'notice' ? 'notice' : 'checkbox'}
              value={field.consentPurposeIds ?? []}
              labels={field.consentPurposeLabels ?? {}}
              onChange={(consentPurposeIds, consentPurposeLabels) => {
                onChange({ consentPurposeIds, consentPurposeLabels })
              }}
            />
          </>
        )}

        {problem !== undefined && <p className="text-[12px] text-danger">{problem}</p>}

        <button
          type="button"
          onClick={onRemove}
          className="self-start rounded-md border border-border px-2.5 py-1.5 text-[12px] font-medium text-danger transition hover:border-danger/50 hover:bg-danger-soft"
        >
          Remove field
        </button>
      </div>
    </aside>
  )
}

/**
 * A select's choices.
 *
 * `key` is what a stored answer holds, so it is editable and it is what the
 * server validates a submit against. Changing a `value` renames the choice on
 * screen without invalidating the answers already recorded under its key, which
 * is the whole reason the two are separate.
 */
function OptionsEditor({
  options,
  onChange,
}: {
  readonly options: readonly FormFieldOptionInput[]
  readonly onChange: (options: readonly FormFieldOptionInput[]) => void
}): React.JSX.Element {
  return (
    <div className="space-y-2">
      <span className="block text-[11px] font-medium text-ink-faint">Options</span>
      {options.map((option, index) => (
        <div key={`${option.key}-${String(index)}`} className="flex items-center gap-2">
          <input
            className={`${inputClass} font-mono text-[12px]`}
            aria-label={`Option ${String(index + 1)} key`}
            value={option.key}
            onChange={(event) => {
              onChange(
                options.map((existing, at) =>
                  at === index ? { ...existing, key: event.target.value } : existing,
                ),
              )
            }}
          />
          <input
            className={inputClass}
            aria-label={`Option ${String(index + 1)} label`}
            value={option.value}
            onChange={(event) => {
              onChange(
                options.map((existing, at) =>
                  at === index ? { ...existing, value: event.target.value } : existing,
                ),
              )
            }}
          />
          <select
            className={`${inputClass} w-24`}
            aria-label={`Option ${String(index + 1)} value type`}
            value={option.valueType ?? 'string'}
            onChange={(event) => {
              onChange(
                options.map((existing, at) =>
                  at === index
                    ? { ...existing, valueType: event.target.value as 'string' | 'number' | 'boolean' }
                    : existing,
                ),
              )
            }}
          >
            {FORM_OPTION_VALUE_TYPES.map((type) => (
              <option key={type} value={type}>
                {type}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => {
              onChange(options.filter((_option, at) => at !== index))
            }}
            aria-label={`Remove option ${option.value}`}
            className="rounded-md px-1.5 py-1 text-[12px] text-ink-faint transition hover:text-danger"
          >
            ✕
          </button>
        </div>
      ))}
      <button
        type="button"
        onClick={() => {
          onChange([
            ...options,
            { key: `option_${String(options.length + 1)}`, value: 'New option', valueType: 'string' },
          ])
        }}
        className="text-[12px] font-medium text-ink-muted transition hover:text-accent"
      >
        + Add option
      </button>
    </div>
  )
}

/**
 * Picks the workspace consent purposes this field offers, with a text input
 * beside each selected purpose so the admin can override the checkbox text.
 * The override is bound to the same purpose the checkbox grants — the wording
 * changes, the mapping never does. An empty override falls back to the
 * workspace purpose's own label at render time.
 */
function ConsentPurposePicker({
  mode,
  value,
  labels,
  onChange,
}: {
  /**
   * `checkbox` shows a text override per selected purpose (each purpose has
   * its own checkbox in the embed). `notice` hides the overrides — the
   * consent is granted implicitly, without a per-purpose checkbox.
   */
  readonly mode: 'checkbox' | 'notice'
  readonly value: readonly string[]
  readonly labels: Readonly<Record<string, string>>
  readonly onChange: (
    ids: readonly string[],
    labels: Readonly<Record<string, string>>,
  ) => void
}): React.JSX.Element {
  const purposes = useConsentPurposes({ sort: 'sort_order', limit: 200 })

  if (purposes.isLoading) {
    return <p className="text-[12px] text-ink-muted">Loading consent purposes…</p>
  }

  if (purposes.records.length === 0) {
    return (
      <p className="text-[12px] text-ink-muted">
        No consent purposes yet. Add one on the Privacy admin page, then pick it here.
      </p>
    )
  }

  const chosen = new Set(value)

  function toggle(id: string, checked: boolean): void {
    // Preserve the workspace's purpose order so the visitor sees the checkboxes
    // in a consistent order regardless of which one the admin ticked first.
    const order = purposes.records.map((purpose) => purpose.id)
    const nextIds = order.filter((purposeId) =>
      purposeId === id ? checked : chosen.has(purposeId),
    )
    // A deselected purpose drops its override too — silent orphan overrides
    // would resurface if the admin ticked it again later.
    const nextLabels: Record<string, string> = {}
    for (const [key, val] of Object.entries(labels)) {
      if (nextIds.includes(key)) nextLabels[key] = val
    }
    onChange(nextIds, nextLabels)
  }

  function setLabel(id: string, text: string): void {
    const nextLabels: Record<string, string> = { ...labels }
    if (text.length === 0) {
      delete nextLabels[id]
    } else {
      nextLabels[id] = text
    }
    onChange(value, nextLabels)
  }

  const legend =
    mode === 'notice'
      ? 'Purposes granted when the visitor submits (implicit consent)'
      : 'Consent purposes (each selected one becomes a checkbox)'

  return (
    <fieldset className="block">
      <legend className="mb-1 block text-[11px] font-medium text-ink-faint">{legend}</legend>
      <div className="flex flex-col gap-2">
        {purposes.records.map((purpose) => {
          const isChosen = chosen.has(purpose.id)
          return (
            <div key={purpose.id} className="rounded-md border border-border p-2">
              <label className="flex items-center gap-2 text-[13px] text-ink">
                <input
                  type="checkbox"
                  checked={isChosen}
                  onChange={(event) => {
                    toggle(purpose.id, event.target.checked)
                  }}
                />
                {purpose.label}
              </label>
              {isChosen && mode === 'checkbox' && (
                <label className="mt-1.5 block">
                  <span className="mb-1 block text-[11px] font-medium text-ink-faint">
                    Checkbox text (defaults to the purpose label)
                  </span>
                  <input
                    className={inputClass}
                    value={labels[purpose.id] ?? ''}
                    onChange={(event) => {
                      setLabel(purpose.id, event.target.value)
                    }}
                    placeholder={purpose.label}
                  />
                </label>
              )}
            </div>
          )
        })}
      </div>
    </fieldset>
  )
}
