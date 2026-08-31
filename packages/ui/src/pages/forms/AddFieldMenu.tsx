import { labelForMapTarget } from '@kelpie/schemas'
import type { FormFieldInput } from '@kelpie/schemas'
import { useEffect, useRef, useState } from 'react'

import { unusedCrmPresets } from './fieldList.ts'
import type { EditableField } from './fieldList.ts'
import { SUBMISSION_FIELD_PRESETS } from './template.ts'

/**
 * The "Add field" button and its menu of ready-made fields.
 *
 * Two groups. CRM presets carry a mapping and appear only while that mapping is
 * free, because a form may carry each CRM target once. Submission-only fields
 * always appear and may repeat. The menu owns nothing but its own open state:
 * the field list lives with the builder, which is what `onAdd` hands the chosen
 * preset back to.
 */
export interface AddFieldMenuProps {
  readonly fields: readonly EditableField[]
  readonly onAdd: (field: FormFieldInput) => void
}

export function AddFieldMenu({ fields, onAdd }: AddFieldMenuProps): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const crmPresets = unusedCrmPresets(fields)

  useEffect(() => {
    if (!open) {
      return
    }

    function onPointerDown(event: MouseEvent): void {
      if (containerRef.current?.contains(event.target as Node) !== true) {
        setOpen(false)
      }
    }

    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape') {
        setOpen(false)
      }
    }

    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)

    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  function add(field: FormFieldInput): void {
    onAdd(field)
    setOpen(false)
  }

  return (
    <div className="relative" ref={containerRef}>
      <button
        type="button"
        onClick={() => {
          setOpen((current) => !current)
        }}
        aria-expanded={open}
        aria-haspopup="menu"
        className="rounded-md bg-accent px-3 py-1.5 text-[12px] font-semibold text-accent-fg transition hover:bg-accent-hover"
      >
        + Add field
      </button>
      {open && (
        <div
          role="menu"
          aria-label="Field to add"
          className="absolute right-0 z-20 mt-1.5 max-h-80 w-64 overflow-y-auto rounded-md border border-border bg-surface-raised py-1"
        >
          {crmPresets.length > 0 && (
            <>
              <p className="px-3 pb-1 pt-1.5 text-[10px] font-semibold uppercase tracking-wide text-ink-faint">
                Writes to the CRM
              </p>
              {crmPresets.map((preset) => (
                <button
                  key={preset.mapTo}
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    add(preset)
                  }}
                  className="flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-[13px] text-ink transition hover:bg-surface-sunken"
                >
                  <span>{preset.label}</span>
                  <span className="shrink-0 text-[11px] text-ink-faint">
                    {labelForMapTarget(preset.mapTo)}
                  </span>
                </button>
              ))}
            </>
          )}
          <p className="px-3 pb-1 pt-1.5 text-[10px] font-semibold uppercase tracking-wide text-ink-faint">
            Submission only
          </p>
          {SUBMISSION_FIELD_PRESETS.map((preset) => (
            <button
              key={preset.menuLabel}
              type="button"
              role="menuitem"
              onClick={() => {
                add(preset.field)
              }}
              className="w-full px-3 py-1.5 text-left text-[13px] text-ink transition hover:bg-surface-sunken"
            >
              {preset.menuLabel}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
