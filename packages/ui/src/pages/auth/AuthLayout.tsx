import type { ReactNode } from 'react'

export interface AuthLayoutProps {
  readonly title: string
  readonly description?: string
  readonly children: ReactNode
}

/** The centred card the signed-out pages sit in. */
export function AuthLayout({ title, description, children }: AuthLayoutProps): React.JSX.Element {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-surface px-4 py-12">
      <div className="mb-8 text-[20px] font-semibold tracking-tight text-ink">Kelpie</div>
      <div className="w-full max-w-sm animate-fade-in rounded-md border border-border p-6">
        <h1 className="text-[18px] font-semibold tracking-tight text-ink">{title}</h1>
        {description !== undefined && (
          <p className="mt-1 text-[13px] text-ink-muted">{description}</p>
        )}
        {children}
      </div>
    </div>
  )
}
