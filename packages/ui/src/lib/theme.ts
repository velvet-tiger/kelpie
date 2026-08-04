import { THEME_PREFERENCES } from '@kelpie/schemas'
import type { ThemePreference } from '@kelpie/schemas'

/**
 * Applying light, dark, or whatever the operating system says.
 *
 * The resolved value goes on `data-theme` and `styles.css` does the rest. What
 * is stored here is a per-browser copy: the account's preference is the source
 * of truth, and this exists so the first paint does not have to wait for it.
 *
 * The preference itself is a wire value, so `ThemePreference` comes from
 * `@kelpie/schemas` rather than being declared again here.
 */

export type { ThemePreference }

const STORAGE_KEY = 'kelpie.theme'

export function getStoredTheme(): ThemePreference {
  const stored = localStorage.getItem(STORAGE_KEY)

  return THEME_PREFERENCES.find((preference) => preference === stored) ?? 'system'
}

export function setStoredTheme(theme: ThemePreference): void {
  localStorage.setItem(STORAGE_KEY, theme)
}

export function resolveTheme(preference: ThemePreference): 'light' | 'dark' {
  if (preference !== 'system') {
    return preference
  }

  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

export function applyTheme(preference: ThemePreference): void {
  document.documentElement.setAttribute('data-theme', resolveTheme(preference))
}

/** Calls back when the operating system flips, for as long as the returned function is uncalled. */
export function watchSystemTheme(onChange: () => void): () => void {
  const query = window.matchMedia('(prefers-color-scheme: dark)')
  const handler = (): void => {
    onChange()
  }

  query.addEventListener('change', handler)

  return () => {
    query.removeEventListener('change', handler)
  }
}
