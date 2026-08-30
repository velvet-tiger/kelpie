import { CUSTOM_FIELD_TYPES_WITH_OPTIONS } from '@kelpie/schemas'
import type {
  CustomFieldDefinition,
  CustomFieldObjectType,
  CustomFieldType,
  CustomFieldValue,
  CustomFieldValues,
} from '@kelpie/schemas'
import { useMemo, useState } from 'react'
import { Link } from 'react-router'

import { useCustomFields } from '../api/resources/customFields.ts'
import { InlineEdit } from './InlineEdit.tsx'

/**
 * Renders the workspace's custom fields for one record as a full-width panel,
 * dropped into a detail page's Fields tab.
 *
 * Each field patches only its own key; the server merges the sent object into
 * stored values in the same transaction.
 *
 * Currency is edited in major units in the box and stored as integer cents,
 * mirroring how DealDetail handles `value_cents`. Multi-select uses a compact
 * checkbox list because InlineEdit only handles one string in and out.
 *
 * `useHasCustomFields` lets a caller decide whether to render the tab at all —
 * a workspace with no definitions should not see a Fields tab full of empty
 * space with only a "go set one up" pointer.
 */

export interface CustomFieldsPanelProps {
  readonly objectType: CustomFieldObjectType
  readonly values: CustomFieldValues
  readonly onPatch: (change: Readonly<Record<string, CustomFieldValue | null>>) => void
}

const OPTIONS_TYPES: ReadonlySet<CustomFieldType> = new Set(CUSTOM_FIELD_TYPES_WITH_OPTIONS)

export function CustomFieldsPanel({
  objectType,
  values,
  onPatch,
}: CustomFieldsPanelProps): React.JSX.Element {
  const definitions = useCustomFields({ objectType, sort: 'sort_order', limit: 200 })

  if (definitions.isLoading) {
    return <p className="text-[13px] text-ink-muted">Loading fields…</p>
  }

  if (definitions.records.length === 0) {
    return (
      <p className="text-[13px] text-ink-muted">
        No custom fields yet. Add them at{' '}
        <Link to="/admin/fields" className="text-accent hover:text-accent-hover">
          Admin → Fields
        </Link>
        .
      </p>
    )
  }

  return (
    <dl className="grid gap-x-8 gap-y-5 sm:grid-cols-2">
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
    </dl>
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
  const type = definition.type as CustomFieldType

  return (
    <div>
      <dt className="text-[10px] font-semibold tracking-wide text-ink-faint uppercase">
        {definition.label}
      </dt>
      {definition.description.length > 0 && (
        <p className="mt-0.5 text-[11px] text-ink-muted">{definition.description}</p>
      )}
      <dd className="mt-1 text-[13px] text-ink">
        <ControlFor definition={definition} type={type} value={value} onChange={onChange} />
      </dd>
    </div>
  )
}

interface ControlForProps {
  readonly definition: CustomFieldDefinition
  readonly type: CustomFieldType
  readonly value: CustomFieldValue | undefined
  readonly onChange: (value: CustomFieldValue | null) => void
}

function ControlFor({
  definition,
  type,
  value,
  onChange,
}: ControlForProps): React.JSX.Element {
  if (type === 'checkbox') {
    return (
      <label className="inline-flex cursor-pointer items-center gap-2">
        <input
          type="checkbox"
          checked={value === true}
          onChange={(event) => {
            onChange(event.target.checked)
          }}
          className="rounded border-border"
        />
        <span>{value === true ? 'Yes' : 'No'}</span>
      </label>
    )
  }

  if (type === 'multi_select') {
    return (
      <MultiSelectField
        options={definition.options}
        selected={Array.isArray(value) ? (value as readonly string[]) : []}
        onChange={onChange}
      />
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
    )
  }

  if (OPTIONS_TYPES.has(type)) {
    // A stored value that is no longer in the definition's options must still
    // be visible until the reader chooses another; keep it in the list.
    const stored = typeof value === 'string' ? value : ''
    const options = optionsWithStale(definition.options, stored)
    return (
      <InlineEdit
        value={stored}
        options={options.map((option) => ({ value: option, label: option }))}
        onChange={(next) => {
          onChange(next.length === 0 ? null : next)
        }}
        emptyLabel="Choose…"
      />
    )
  }

  if (type === 'number') {
    const current = typeof value === 'number' ? String(value) : ''
    return (
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
    )
  }

  const inputType: 'text' | 'date' | 'url' | 'email' =
    type === 'date' ? 'date' : type === 'url' ? 'url' : 'text'
  const multiline = type === 'long_text'
  const current = typeof value === 'string' ? value : ''

  return (
    <InlineEdit
      type={inputType}
      multiline={multiline}
      value={current}
      onChange={(next) => {
        onChange(next.length === 0 ? null : next)
      }}
      emptyLabel="Add…"
    />
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
      {chips ?? <span className="text-ink-faint">None</span>}
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
