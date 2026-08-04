import type { ReactNode } from 'react'

/** A labelled control, with the optional line of help under it. */
export function Field({
  label,
  hint,
  children,
}: {
  readonly label: string
  readonly hint?: string
  readonly children: ReactNode
}): React.JSX.Element {
  return (
    <label className="block">
      <span className="mb-1.5 block text-[12px] font-medium text-ink">{label}</span>
      {children}
      {hint !== undefined && <span className="mt-1 block text-[11px] text-ink-faint">{hint}</span>}
    </label>
  )
}
