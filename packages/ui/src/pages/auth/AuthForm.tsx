/**
 * The controls the signed-out pages share.
 *
 * Seven forms across sign-in, signup, the two reset pages, and onboarding wrote
 * the same label, input, and button markup. One copy of it here means a change
 * to how a field looks is one edit rather than seven, and a page reads as what
 * it asks for rather than as a wall of class names.
 */

/**
 * Exported for the one control `TextField` cannot express: the invite row pairs
 * an address with a role on a single line, so neither gets its own label.
 */
export const AUTH_INPUT_CLASS =
  'w-full rounded-md border border-border bg-surface px-3 py-2 text-[13px] outline-none focus:border-accent focus:ring-2 focus:ring-accent/20'

export interface TextFieldProps {
  readonly label: string
  readonly type?: 'text' | 'email' | 'password'
  readonly value: string
  readonly onChange: (value: string) => void
  /** What a password manager should offer here. Always worth setting on a credential. */
  readonly autoComplete?: string
  readonly placeholder?: string
  readonly hint?: string
  readonly required?: boolean
  /** A slug or a token: characters the reader has to be able to tell apart. */
  readonly mono?: boolean
}

export function TextField({
  label,
  type = 'text',
  value,
  onChange,
  autoComplete,
  placeholder,
  hint,
  required = false,
  mono = false,
}: TextFieldProps): React.JSX.Element {
  return (
    <label className="block">
      <span className="mb-1.5 block text-[12px] font-medium text-ink">{label}</span>
      <input
        type={type}
        value={value}
        onChange={(event) => {
          onChange(event.target.value)
        }}
        autoComplete={autoComplete}
        placeholder={placeholder}
        required={required}
        className={mono ? `${AUTH_INPUT_CLASS} font-mono` : AUTH_INPUT_CLASS}
      />
      {hint !== undefined && <span className="mt-1 block text-[11px] text-ink-faint">{hint}</span>}
    </label>
  )
}

export interface SubmitButtonProps {
  readonly label: string
  /** Shown while the request is in flight, so the button says what is happening. */
  readonly pendingLabel: string
  readonly isPending: boolean
}

const PRIMARY_CLASS =
  'w-full rounded-md bg-accent px-3.5 py-2 text-[12px] font-semibold text-accent-fg transition hover:bg-accent-hover disabled:opacity-50'

export function SubmitButton({
  label,
  pendingLabel,
  isPending,
}: SubmitButtonProps): React.JSX.Element {
  return (
    <button type="submit" disabled={isPending} className={PRIMARY_CLASS}>
      {isPending ? pendingLabel : label}
    </button>
  )
}

/** The same button where there is no form to submit, only somewhere to go next. */
export function PrimaryButton({
  label,
  onClick,
}: {
  readonly label: string
  readonly onClick: () => void
}): React.JSX.Element {
  return (
    <button type="button" onClick={onClick} className={PRIMARY_CLASS}>
      {label}
    </button>
  )
}

/** The same button as a plain action: skipping a step, or finishing one. */
export function SecondaryButton({
  label,
  onClick,
  disabled = false,
}: {
  readonly label: string
  readonly onClick: () => void
  readonly disabled?: boolean
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="w-full rounded-md border border-border bg-surface px-3.5 py-2 text-[12px] font-medium text-ink-muted transition hover:bg-surface-raised disabled:opacity-50"
    >
      {label}
    </button>
  )
}
