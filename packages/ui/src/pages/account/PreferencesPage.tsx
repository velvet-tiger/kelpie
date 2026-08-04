import { THEME_PREFERENCES } from '@kelpie/schemas'
import type { AccountPreferences, ThemePreference } from '@kelpie/schemas'
import { useState } from 'react'
import type { FormEvent, ReactNode } from 'react'

import {
  useAccountPreferences,
  useTheme,
  useUpdateAccountPreferences,
} from '../../api/resources/account.ts'
import { PageHeader } from '../../components/PageHeader.tsx'
import { ErrorPanel, LoadingPanel } from '../../components/QueryState.tsx'
import { Field } from './Field.tsx'

/**
 * Appearance, timezone, and what to email.
 *
 * Ported from the mockup's Preferences page. Appearance is applied the moment it
 * is clicked, because it is visible in the click; everything else waits for the
 * save button, as the mockup does.
 */

const THEME_LABELS: Readonly<Record<ThemePreference, string>> = {
  system: 'System',
  light: 'Light',
  dark: 'Dark',
}

/**
 * The zones the mockup offered, plus whatever this account already holds. A full
 * IANA list needs a combo box, which is its own piece of work, and an unlisted
 * stored value must survive a save rather than being rewritten to the first
 * option.
 */
const COMMON_TIMEZONES = [
  'Australia/Sydney',
  'Australia/Melbourne',
  'America/Los_Angeles',
  'America/New_York',
  'Europe/London',
  'UTC',
] as const

export function PreferencesPage(): React.JSX.Element {
  const { preferences, isLoading, error } = useAccountPreferences()

  if (error !== null) {
    return <ErrorPanel error={error} />
  }

  if (isLoading || preferences === undefined) {
    return <LoadingPanel />
  }

  return <PreferencesForm preferences={preferences} />
}

function PreferencesForm({
  preferences,
}: {
  readonly preferences: AccountPreferences
}): React.JSX.Element {
  const { theme, setTheme } = useTheme()
  const update = useUpdateAccountPreferences()
  const [timezone, setTimezone] = useState(preferences.timezone)
  const [emailDigest, setEmailDigest] = useState(preferences.emailDigest)
  const [mentionEmails, setMentionEmails] = useState(preferences.mentionEmails)
  const [productUpdates, setProductUpdates] = useState(preferences.productUpdates)
  const [saved, setSaved] = useState(false)

  const zones = COMMON_TIMEZONES.includes(timezone as (typeof COMMON_TIMEZONES)[number])
    ? [...COMMON_TIMEZONES]
    : [timezone, ...COMMON_TIMEZONES]

  function save(event: FormEvent): void {
    event.preventDefault()
    setSaved(false)

    update
      // Theme is left out deliberately: it is already saved, by the control that
      // changed it. Sending the current one back would undo a click made while
      // this form sat open.
      .runAsync({ timezone, emailDigest, mentionEmails, productUpdates })
      .then(() => {
        setSaved(true)
      })
      .catch(() => undefined)
  }

  return (
    <div className="animate-slide-in space-y-6">
      <PageHeader
        title="Preferences"
        description="Appearance, timezone, and email notifications."
      />

      <form onSubmit={save} className="space-y-5">
        <fieldset>
          <legend className="mb-1.5 text-[12px] font-medium text-ink">Appearance</legend>
          <div className="inline-flex rounded-md border border-border p-0.5">
            {THEME_PREFERENCES.map((value) => (
              <button
                key={value}
                type="button"
                onClick={() => {
                  setTheme(value)
                }}
                className={[
                  'rounded px-2.5 py-1 text-[12px] transition',
                  theme === value
                    ? 'bg-surface-sunken font-medium text-ink'
                    : 'text-ink-muted hover:text-ink',
                ].join(' ')}
              >
                {THEME_LABELS[value]}
              </button>
            ))}
          </div>
          <p className="mt-1 text-[11px] text-ink-faint">
            Saved to your account as you click, and applied in every browser you sign in to.
          </p>
        </fieldset>

        <div className="max-w-md">
          <Field
            label="Timezone"
            hint="Stored on your account. Kelpie does not format dates by it yet."
          >
            <select
              value={timezone}
              onChange={(event) => {
                setTimezone(event.target.value)
              }}
              className="w-full rounded-md border border-border bg-surface-raised px-3 py-1.5 text-[13px] outline-none focus:border-accent"
            >
              {zones.map((zone) => (
                <option key={zone} value={zone}>
                  {zone}
                </option>
              ))}
            </select>
          </Field>
        </div>

        <fieldset className="space-y-2">
          <legend className="text-[12px] font-medium text-ink">Email notifications</legend>
          {/* Said plainly rather than left to be inferred from a toggle that
              looks live. Kelpie sends no notification email yet; these record
              the answer for when it does. */}
          <p className="max-w-lg text-[11px] text-ink-faint">
            Kelpie does not send these emails yet. Your choices are saved and will apply when it
            does.
          </p>
          <Toggle
            checked={emailDigest}
            onChange={setEmailDigest}
            label="Weekly digest"
            description="Summary of deals, decisions, and activity."
          />
          <Toggle
            checked={mentionEmails}
            onChange={setMentionEmails}
            label="Mentions and assignments"
            description="When someone mentions you or assigns a Plan item."
          />
          <Toggle
            checked={productUpdates}
            onChange={setProductUpdates}
            label="Product updates"
            description="Occasional notes about Kelpie releases."
          />
        </fieldset>

        {update.error !== null && (
          <div className="max-w-lg">
            <ErrorPanel error={update.error} />
          </div>
        )}

        <button
          type="submit"
          disabled={update.isPending}
          className="rounded-md bg-accent px-3 py-1.5 text-[12px] font-medium text-accent-fg transition hover:bg-accent-hover disabled:opacity-50"
        >
          {update.isPending ? 'Saving…' : saved ? 'Saved' : 'Save preferences'}
        </button>
      </form>
    </div>
  )
}

function Toggle({
  checked,
  onChange,
  label,
  description,
}: {
  readonly checked: boolean
  readonly onChange: (value: boolean) => void
  readonly label: string
  readonly description: string
}): ReactNode {
  return (
    <label className="flex max-w-lg cursor-pointer items-start gap-3 rounded-md border border-border px-3 py-2.5">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => {
          onChange(event.target.checked)
        }}
        className="mt-0.5 h-4 w-4 rounded border-border text-accent focus:ring-accent/20"
      />
      <span>
        <span className="block text-[13px] font-medium text-ink">{label}</span>
        <span className="mt-0.5 block text-[12px] text-ink-muted">{description}</span>
      </span>
    </label>
  )
}
