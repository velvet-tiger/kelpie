import type { ReactNode } from 'react'

export type ChipTone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger'

export interface ChipProps {
  readonly children: ReactNode
  readonly tone?: ChipTone
  readonly onClick?: () => void
}

const toneClasses: Readonly<Record<ChipTone, string>> = {
  neutral: 'bg-surface-sunken text-ink-muted border-transparent',
  accent: 'bg-accent-soft text-accent border-transparent',
  success: 'bg-success-soft text-success border-transparent',
  warning: 'bg-warning-soft text-warning border-transparent',
  danger: 'bg-danger-soft text-danger border-transparent',
}

/** A small status pill. Ported from `RecordHeader.tsx` in the mockups. */
export function Chip({ children, tone = 'neutral', onClick }: ChipProps): React.JSX.Element {
  const className = [
    'inline-flex items-center rounded border px-1.5 py-0.5 text-[10px] font-medium leading-none',
    toneClasses[tone],
    onClick === undefined ? '' : 'cursor-pointer hover:ring-1 hover:ring-border',
  ].join(' ')

  if (onClick === undefined) {
    return <span className={className}>{children}</span>
  }

  return (
    <button type="button" onClick={onClick} className={className}>
      {children}
    </button>
  )
}
