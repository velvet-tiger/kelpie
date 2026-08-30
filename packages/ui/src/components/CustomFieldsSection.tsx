import { CUSTOM_FIELD_TYPES_WITH_OPTIONS } from '@kelpie/schemas'
import type {
  CustomFieldDefinition,
  CustomFieldObjectType,
  CustomFieldType,
  CustomFieldValue,
  CustomFieldValues,
} from '@kelpie/schemas'
import { useMemo, useState } from 'react'

import { useCustomFields } from '../api/resources/customFields.ts'
import { InlineEdit } from './InlineEdit.tsx'
import { SidebarField } from './SidebarField.tsx'

/**
 * Renders the workspace's custom fields for one record in a detail-page
 * sidebar.
 *
 * Each field patches only its own key; the server merges the sent object into
 * stored values in the same transaction.
 *
 * Currency is edited in major units in the box and stored as integer cents,
 * mirroring how DealDetail handles `value_cents`. Multi-select uses a compact
 * checkbox list because InlineEdit only handles one string in and out.
 */

export interface CustomFieldsSectionProps {
  readonly objectType: CustomFieldObjectType
  readonly values: CustomFieldValues
  readonly onPatch: (change: Readonly<Record<string, CustomFieldValue | null>>) => void
}

const OPTIONS_TYPES: ReadonlySet<CustomFieldType> = new Set(CUSTOM_FIELD_TYPES_WITH_OPTIONS)

export function CustomFieldsSection({
  objectType,
  values,
  onPatch,
}: CustomFieldsSectionProps): React.JSX.Element | null {
  const definitions = useCustomFields({ objectType, sort: 'sort_order', limit: 200 })

  if (definitions.isLoading || definitions.records.length === 0) {
    return null
  }

  return (
    <>
      {definitions.records.map((definition) => (
        <CustomFieldControl
          key={definition.id}
          definition={definition}
          value={values[definition.key]}
          onChange={(next) => {
            onPatch({ [definition.key]: next })
          }}
        />
      ))}
    </>
  )
}

interface CustomFieldControlProps {
  readonly definition: CustomFieldDefinition
  readonly value: CustomFieldValue | undefined
  readonly onChange: (value: CustomFieldValue | null) => void
}

function CustomFieldControl({
  definition,
  value,
  onChange,
}: CustomFieldControlProps): React.JSX.Element {
  const label = definition.label
  const type = definition.type as CustomFieldType

  if (type === 'checkbox') {
    return (
      <SidebarField label={label}>
        <label className="inline-flex cursor-pointer items-center gap-2">
          <input
            type="checkbox"
            checked={value === true}
            onChange={(event) => {
              onChange(event.target.checked)
            }}
            className="rounded border-border"
          />
          <span className="text-[13px] text-ink">
            {value === true ? 'Yes' : 'No'}
          </span>
        </label>
      </SidebarField>
    )
  }

  if (type === 'multi_select') {
    return (
      <SidebarField label={label}>
        <MultiSelectField
          options={definition.options}
          selected={Array.isArray(value) ? (value as readonly string[]) : []}
          onChange={onChange}
        />
      </SidebarField>
    )
  }

  if (type === 'currency') {
    const currentCents =
      typeof value === 'object' &&
      value !== null &&
      !Array.isArray(value) &&
      'amountCents' in value
        ? value.amountCents
        : null
    const currentCurrency =
      typeof value === 'object' &&
      value !== null &&
      !Array.isArray(value) &&
      'currency' in value
        ? value.currency
        : 'USD'

    return (
      <SidebarField label={label}>
        <InlineEdit
          type="number"
          value={currentCents === null ? '' : String(currentCents / 100)}
          onChange={(raw) => {
            const trimmed = raw.trim()
            if (trimmed.length === 0) {
              onChange(null)
              return
            }
            const parsed = Number(trimmed)
            if (!Number.isFinite(parsed)) {
              return
            }
            onChange({
              amountCents: Math.round(parsed * 100),
              currency: currentCurrency,
            })
          }}
          emptyLabel="Add…"
        />
      </SidebarField>
    )
  }

  if (OPTIONS_TYPES.has(type)) {
    // A stored value that is no longer in the definition's options must still
    // be visible until the reader chooses another; keep it in the list.
    const stored = typeof value === 'string' ? value : ''
    const options = optionsWithStale(definition.options, stored)

    return (
      <SidebarField label={label}>
        <InlineEdit
          value={stored}
          options={options.map((option) => ({ value: option, label: option }))}
          onChange={(next) => {
            onChange(next.length === 0 ? null : next)
          }}
          emptyLabel="Choose…"
        />
      </SidebarField>
    )
  }

  if (type === 'number') {
    const current = typeof value === 'number' ? String(value) : ''
    return (
      <SidebarField label={label}>
        <InlineEdit
          type="number"
          value={current}
          onChange={(raw) => {
            const trimmed = raw.trim()
            if (trimmed.length === 0) {
              onChange(null)
              return
            }
            const parsed = Number(trimmed)
            if (Number.isFinite(parsed)) {
              onChange(parsed)
            }
          }}
          emptyLabel="Add…"
        />
      </SidebarField>
    )
  }

  const inputType: 'text' | 'date' | 'url' | 'email' =
    type === 'date' ? 'date' : type === 'url' ? 'url' : 'text'
  const multiline = type === 'long_text'
  const current = typeof value === 'string' ? value : ''

  return (
    <SidebarField label={label}>
      <InlineEdit
        type={inputType}
        multiline={multiline}
        value={current}
        onChange={(next) => {
          onChange(next.length === 0 ? null : next)
        }}
        emptyLabel="Add…"
      />
    </SidebarField>
  )
}

interface MultiSelectFieldProps {
  readonly options: readonly string[]
  readonly selected: readonly string[]
  readonly onChange: (value: readonly string[] | null) => void
}

function MultiSelectField({
  options,
  selected,
  onChange,
}: MultiSelectFieldProps): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const allOptions = useMemo(
    () => optionsWithStale(options, ...selected),
    [options, selected],
  )

  const chips = selected.length === 0 ? null : (
    <div className="flex flex-wrap gap-1">
      {selected.map((entry) => (
        <span
          key={entry}
          className="inline-flex items-center gap-1 rounded-full bg-surface-raised px-2 py-0.5 text-[11px]"
        >
          {entry}
          <button
            type="button"
            onClick={() => {
              const next = selected.filter((existing) => existing !== entry)
              onChange(next.length === 0 ? null : next)
            }}
            className="text-ink-muted hover:text-ink"
            aria-label={`Remove ${entry}`}
          >
            ×
          </button>
        </span>
      ))}
    </div>
  )

  return (
    <div className="space-y-1">
      {chips ?? <span className="text-[13px] text-ink-faint">None</span>}
      <button
        type="button"
        onClick={() => {
          setOpen((current) => !current)
        }}
        className="text-[12px] text-ink-muted hover:text-ink"
      >
        {open ? 'Close' : 'Edit'}
      </button>
      {open && (
        <ul className="space-y-1 rounded-md border border-border bg-surface-raised p-2">
          {allOptions.map((option) => {
            const chosen = selected.includes(option)
            return (
              <li key={option}>
                <label className="flex cursor-pointer items-center gap-2 text-[12px]">
                  <input
                    type="checkbox"
                    checked={chosen}
                    onChange={() => {
                      const next = chosen
                        ? selected.filter((existing) => existing !== option)
                        : [...selected, option]
                      onChange(next.length === 0 ? null : next)
                    }}
                  />
                  <span>{option}</span>
                </label>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}

function optionsWithStale(
  options: readonly string[],
  ...stored: readonly string[]
): readonly string[] {
  const seen = new Set(options)
  const extras = stored.filter((entry) => entry.length > 0 && !seen.has(entry))
  return extras.length === 0 ? options : [...options, ...extras]
}
