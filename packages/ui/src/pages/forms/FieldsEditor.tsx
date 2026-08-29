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
import { FORM_FIELD_MAP_TARGET_LABELS, FORM_OPTION_VALUE_TYPES } from '@kelpie/schemas'
import type {
  Form,
  FormFieldInput,
  FormFieldMapTarget,
  FormFieldOptionInput,
  FormFieldType,
} from '@kelpie/schemas'
import { useEffect, useRef, useState } from 'react'

import { useUpdateFormFields } from '../../api/resources/forms.ts'
import { ErrorPanel } from '../../components/QueryState.tsx'
import { AddFieldMenu } from './AddFieldMenu.tsx'
import {
  FIELD_TYPE_OPTIONS,
  MAP_TARGET_OPTIONS,
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

  const problems = findProblems(fields, form.createDeal)
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

interface FieldSettingsProps {
  readonly field: EditableField
  readonly problem: string | undefined
  readonly onChange: (change: Partial<FormFieldInput>) => void
  readonly onRemove: () => void
  readonly onClose: () => void
}

/** The panel a selected field's settings edit in. */
function FieldSettings({
  field,
  problem,
  onChange,
  onRemove,
  onClose,
}: FieldSettingsProps): React.JSX.Element {
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

        <label className="block">
          <span className="mb-1 block text-[11px] font-medium text-ink-faint">Maps to</span>
          <select
            className={inputClass}
            value={field.mapTo}
            onChange={(event) => {
              const mapTo = event.target.value as FormFieldMapTarget

              onChange({ mapTo, type: typeForTarget(mapTo, field.type) })
            }}
          >
            {MAP_TARGET_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {FORM_FIELD_MAP_TARGET_LABELS[option.value]}
              </option>
            ))}
          </select>
        </label>

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
