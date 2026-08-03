import type { ReactNode } from 'react'

export interface SidebarFieldProps {
  readonly label: string
  readonly children: ReactNode
}

/** One labelled row in a record's sidebar. Ported from `RelatedList.tsx` in the mockups. */
export function SidebarField({ label, children }: SidebarFieldProps): React.JSX.Element {
  return (
    <div className="border-t border-border py-2 first:border-t-0 first:pt-0">
      <div className="mb-0.5 text-[10px] font-semibold tracking-wide text-ink-faint uppercase">
        {label}
      </div>
      <div className="min-w-0 text-[12px] leading-snug text-ink">{children}</div>
    </div>
  )
}
