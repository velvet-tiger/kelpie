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
import type { Form, FormFieldMapTarget, FormFieldOptionInput, FormFieldType } from '@kelpie/schemas'
import { useEffect, useState } from 'react'

import { useUpdateFormFields } from '../../api/resources/forms.ts'
import { ErrorPanel } from '../../components/QueryState.tsx'
import { SectionHeader } from '../../components/SectionHeader.tsx'
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
import { NEW_FIELD } from './template.ts'

/**
 * The field builder.
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
  const updateFields = useUpdateFormFields()
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor),
  )

  // A save answers with the stored list, ids and all. Re-reading it here is what
  // turns the local ids of newly added fields into the real ones.
  useEffect(() => {
    setFields(toEditableFields(form))
  }, [form])

  const problems = findProblems(fields, form.createDeal)
  const changed = fieldsChanged(form, fields)

  function onDragEnd(event: DragEndEvent): void {
    const overId = event.over?.id

    if (overId !== undefined) {
      setFields((current) => reorderFields(current, String(event.active.id), String(overId)))
    }
  }

  function save(): void {
    updateFields.run({ id: form.id, fields: toFieldInputs(fields) })
  }

  return (
    <div className="max-w-3xl">
      <SectionHeader
        title="Fields"
        description="Drag to reorder. What a field maps to decides what a submission writes."
        onAdd={() => {
          setFields((current) => insertField(current, { ...NEW_FIELD, id: localFieldId() }, null))
        }}
        addLabel="Add field"
      />

      {problems.list.map((problem) => (
        <p key={problem} className="mb-2 text-[12px] text-danger">
          {problem}
        </p>
      ))}

      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <SortableContext items={fields.map((field) => field.id)} strategy={verticalListSortingStrategy}>
          <ul className="flex flex-col gap-2">
            {fields.map((field) => (
              <SortableField
                key={field.id}
                field={field}
                problem={problems.byField.get(field.id)}
                onChange={(change) => {
                  setFields((current) => editField(current, field.id, change))
                }}
                onRemove={() => {
                  setFields((current) => removeField(current, field.id))
                }}
                onAddBelow={() => {
                  setFields((current) =>
                    insertField(current, { ...NEW_FIELD, id: localFieldId() }, field.id),
                  )
                }}
              />
            ))}
          </ul>
        </SortableContext>
      </DndContext>

      {fields.length === 0 && (
        <p className="rounded-md border border-dashed border-border px-6 py-10 text-center text-[13px] text-ink-muted">
          No fields yet. A form needs at least an email field.
        </p>
      )}

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

interface SortableFieldProps {
  readonly field: EditableField
  readonly problem: string | undefined
  readonly onChange: (change: Partial<EditableField>) => void
  readonly onRemove: () => void
  readonly onAddBelow: () => void
}

function SortableField({
  field,
  problem,
  onChange,
  onRemove,
  onAddBelow,
}: SortableFieldProps): React.JSX.Element {
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
      className={[
        'rounded-md border bg-surface-raised p-3',
        problem === undefined ? 'border-border' : 'border-danger/50',
      ].join(' ')}
    >
      <div className="flex items-start gap-2">
        <button
          type="button"
          className="cursor-grab touch-none px-1 py-2 text-[10px] text-ink-faint active:cursor-grabbing"
          aria-label={`Drag ${field.label} to reorder`}
          {...attributes}
          {...listeners}
        >
          ⋮⋮
        </button>

        <div className="grid flex-1 gap-2 sm:grid-cols-2">
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
        </div>

        <div className="flex shrink-0 flex-col items-end gap-1">
          <button
            type="button"
            onClick={onRemove}
            aria-label={`Remove ${field.label}`}
            className="rounded-md px-1.5 py-1 text-[12px] text-ink-faint transition hover:text-danger"
          >
            ✕
          </button>
          <button
            type="button"
            onClick={onAddBelow}
            aria-label={`Add a field below ${field.label}`}
            className="rounded-md px-1.5 py-1 text-[12px] text-ink-faint transition hover:text-accent"
          >
            +
          </button>
        </div>
      </div>

      <label className="mt-2 flex items-center gap-2 pl-7 text-[12px] text-ink-muted">
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

      {problem !== undefined && <p className="mt-2 pl-7 text-[12px] text-danger">{problem}</p>}
    </li>
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
    <div className="mt-3 space-y-2 pl-7">
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
            className={`${inputClass} w-28`}
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
